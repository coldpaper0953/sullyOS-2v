// SullyOS 备份系统:导出/导入/重置,自 context/OSContext.tsx 拆出(2026-09-04)。
// 函数体与拆分前逐行等价,仅把 Provider 作用域依赖改为 deps 参数注入;
// JSZip 动态加载器与导入中断标记辅助也一并搬到这里(OSContext re-export 保持旧路径可用)。
import { DB } from './db';
import { FullBackupData, OSTheme, ApiPreset, AppearancePreset, RealtimeConfig, CharacterProfile, CharacterGroup, Worldbook, NovelBook, SongSheet, UserProfile, APIConfig, GroupProfile, Message } from '../types';
import { extractImagesInPlace, deepCloneForExport, parseImageDataUrlForBackup, buildMalformedImageDiagnostics, type BackupObjectPath, type MalformedBackupImageDiagnostic } from './backupExport';
import { createV2ArrayFieldWriter, writeV2Backup, assembleV2Backup, type BackupManifest, type ZipFileWriter, type ZipFileReader } from './backupFormat';
import { collectBlobRefs, writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip } from './backupBlobs';
import { isBlobRef, getBlobForRef, restoreBlobRef, migrateDataUrlToRef, migrateAppearancePresetBlobRefs, BLOBREF_PREFIX } from './blobRef';
import { externalizeVoiceMessageBlobs, restoreVoiceMessageBlobs, shouldIncludeVoiceRelatedAssetInBackup } from './voiceMessageBackup';
import { ensureCompanionVoiceAssetsForBackup, isCompanionVoiceAssetId } from './companionVoiceAssets';
import { collectCharacterCompanionVoiceAssetIds } from './companionPresets';
import { encodeVectorsForBackup, encodeVectorsForBackupChunked } from './memoryPalace/db';
import { exportStoryTheaterAppearanceSetting, restoreStoryTheaterAppearanceSetting } from './storyTheaterBackup';
import { exportPostOfficeLocal } from './vrWorld/postOffice';
import { exportSignalLocal } from './vrWorld/signal';
import { exportWorldHomeLocal } from './worldHome/localBackup';
import { exportLuckinLocal } from './luckinMcpClient';
import { exportMcdLocal } from './mcdMcpClient';
import { exportMcpLocal } from './mcpClient';
import { exportDesktopSkinLocal } from './desktopSkinBackup';
import { assertSupportedSullyBackup } from './backupImportPolicy';
import { exportAmsg2GlobalConfig } from './activeMsgStore';
import { normalizeCharacterRoomAssetsInPlace } from './roomTemplateAssets';
import { formatBytes } from './format';
import { markBackupDone } from './backupReminder';
import { normalizeModelIds } from './modelList';
import { normalizeApiPreset } from './apiConfigNormalize';
import { normalizeCharacterImpression, normalizeCharacterDefaults } from './impression';
import { migrateSharkpanAssets } from './sharkpanAssetMigration';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { syncAmsgToolConfigAndPrompts } from './amsgStateSync';
import { getCheckPhoneApi, setCheckPhoneApi } from './checkPhoneApi';
import { loadMusicPlaybackSnapshot } from '../context/MusicContext';
import { migrateCharacterContextRange } from './chatContextRange';
import type { MemoryPalaceGlobalConfig } from '../context/OSContext';

export type SysOperationState = { status: 'idle' | 'processing', message: string, progress: number };

// ---- 依赖注入接口:由 OSContext 调用点传 Provider 状态与操作 ----
export interface BackupExportDeps {
  apiConfig: APIConfig;
  apiPresets: ApiPreset[];
  availableModels: string[];
  realtimeConfig: RealtimeConfig;
  memoryPalaceConfig: MemoryPalaceGlobalConfig;
  theme: OSTheme;
  customIcons: Record<string, string>;
  appearancePresets: AppearancePreset[];
  characters: CharacterProfile[];
  groups: (CharacterGroup | GroupProfile)[];
  worldbooks: Worldbook[];
  novels: NovelBook[];
  cloudBackupConfig: unknown;
  customThemes: any[];
  userProfile: UserProfile | null;
  setSysOperation: (v: SysOperationState) => void;
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void;
  setGroups?: (groups: (CharacterGroup | GroupProfile)[]) => void;
}

export interface BackupImportDeps extends BackupExportDeps {
  updateTheme: (updates: Partial<OSTheme>) => Promise<void>;
  updateApiConfig: (updates: Partial<APIConfig>) => void;
  updateRealtimeConfig: (updates: Partial<RealtimeConfig>) => void;
  updateMemoryPalaceConfig: (updates: Partial<MemoryPalaceGlobalConfig>) => void;
  saveModels: (models: string[]) => void;
  savePresets: (presets: ApiPreset[]) => void;
  setCharacters: (chars: CharacterProfile[]) => void;
  setGroups: (groups: (CharacterGroup | GroupProfile)[]) => void;
  setWorldbooks: (books: Worldbook[]) => void;
  setNovels: (novels: NovelBook[]) => void;
  setSongs: (songs: SongSheet[]) => void;
  setCustomThemes: (themes: any[]) => void;
  setCustomIcons: (icons: Record<string, string>) => void;
  setAppearancePresets: (presets: AppearancePreset[]) => void;
  setUserProfile: (user: UserProfile | null) => void;
}

export interface BackupResetDeps {
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void;
}

// ==== 以下为 OSContext 原模块级辅助(未改动) ====
type JSZipFileLike = {
  async(type: 'string' | 'base64'): Promise<string>;
  async(type: 'uint8array'): Promise<Uint8Array>;
};

type JSZipWriteOptions = {
  base64?: boolean;
  compression?: 'STORE' | 'DEFLATE';
  compressionOptions?: { level?: number };
};

type JSZipLike = {
  folder: (name: string) => { file: (name: string, data: string, options?: JSZipWriteOptions) => void } | null;
  file: {
    (name: string): JSZipFileLike | null;
    (name: string, data: string | Uint8Array, options?: JSZipWriteOptions): void;
  };
  generateAsync: (
    options: {
      type: 'blob';
      streamFiles?: boolean;
      compression?: string;
      compressionOptions?: { level: number };
    },
    onUpdate?: (metadata: { percent: number }) => void
  ) => Promise<Blob>;
};

type JSZipCtorLike = {
  new (): JSZipLike;
  loadAsync: (file: File) => Promise<JSZipLike>;
};

let jszipCtorPromise: Promise<JSZipCtorLike> | null = null;

export const IMPORT_IN_PROGRESS_KEY = 'sullyos_import_in_progress_v1';

export type ImportProgressUpdate = {
  sourceSize?: number;
  assetDone?: number;
  assetTotal?: number;
  current?: string;
  currentFile?: string;
  currentFileSize?: number;
  itemDone?: number;
  itemTotal?: number;
  error?: string;
};

// localStorage 数值键的导出读取：键缺失或非数字时返回 undefined，
// 让 JSON 里干脆不出现该字段（导入端 typeof 判断保持「没带就不动」语义）。
const readOptionalNumber = (key: string): number | undefined => {
  const raw = localStorage.getItem(key);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

// ==== stripSecrets（GitHub 自动备份的密钥剥离）====
// 设计约束：
//  1. 只认「字段名长得像凭据」——apiKey / token / secret / password / privateKey /
//     sharedKey / authHeader 等。裸 "key" 不算（vrPresets 的 key 是风格 ID，剥了会坏数据）。
//  2. 只清值（''），不改结构、不删字段——导入端全是 typeof/length 判断，空串 =「没配」。
//  3. cloudBackupConfig（备份凭据本身）整段置 undefined：它不该出现在任何备份包里。
const SECRET_FIELD_RE = /api[-_]?key|apikey|token|secret|password|passphrase|private[-_]?key|shared[-_]?key|authorization|auth[-_]?header|bearer|-auth$/i;

/** 纯函数版（返回新树）：流式分片逐条剥用这个，vitest 直测。 */
export const deepStripSecrets = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(deepStripSecrets) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'string' && SECRET_FIELD_RE.test(k) ? '' : deepStripSecrets(v);
    }
    return out as T;
  }
  return value;
};

/** 原地版：backupData 整棵树一次性剥（full 模式的 characters 等也在里面）。 */
const deepStripSecretsInPlace = (obj: Record<string, unknown>): void => {
  if (Array.isArray(obj)) {
    obj.forEach(item => { if (item && typeof item === 'object') deepStripSecretsInPlace(item as Record<string, unknown>); });
    return;
  }
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    if (k === 'cloudBackupConfig') { (obj as any)[k] = undefined; continue; }
    if (typeof v === 'string') {
      if (SECRET_FIELD_RE.test(k)) (obj as any)[k] = '';
      continue;
    }
    if (v && typeof v === 'object') deepStripSecretsInPlace(v);
  }
};

/** text_only 流式分片需要逐条剥密钥的 store（情绪 API 嵌在角色上、彼方设置带独立 API）。 */
const stripSecretsForStore = (storeName: string): boolean =>
  storeName === 'deps.characters' || storeName === 'vr_settings';

let _importStartedAt: number | null = null;
let _importSource: string | null = null;

const markImportInProgress = (phase: string, source?: string, update: ImportProgressUpdate = {}) => {
  try {
    let startedAt = Date.now();
    let existingSource = source || null;

    if (phase === 'parsing') {
      _importStartedAt = startedAt;
      _importSource = existingSource;
    } else {
      if (_importStartedAt) startedAt = _importStartedAt;
      if (!existingSource && _importSource) existingSource = _importSource;
    }

    localStorage.setItem(IMPORT_IN_PROGRESS_KEY, JSON.stringify({
      startedAt,
      updatedAt: Date.now(),
      phase,
      source: existingSource,
      ...update,
    }));
  } catch { /* ignore */ }
};

const clearImportInProgress = () => {
  _importStartedAt = null;
  _importSource = null;
  try { localStorage.removeItem(IMPORT_IN_PROGRESS_KEY); } catch { /* ignore */ }
};

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
  const existing = document.querySelector(`script[data-src="${src}"]`) as HTMLScriptElement | null;
  if (existing) {
    if ((existing as any).dataset.loaded === 'true') {
      resolve();
      return;
    }
    existing.addEventListener('load', () => resolve(), { once: true });
    existing.addEventListener('error', () => reject(new Error(`load failed: ${src}`)), { once: true });
    return;
  }

  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset.src = src;
  script.onload = () => {
    script.dataset.loaded = 'true';
    resolve();
  };
  script.onerror = () => reject(new Error(`load failed: ${src}`));
  document.head.appendChild(script);
});

export const loadJSZip = async (): Promise<JSZipCtorLike> => {
  if (!jszipCtorPromise) {
    jszipCtorPromise = import('jszip')
      .then((mod) => ((mod as any).default || mod) as JSZipCtorLike)
      .catch((error) => {
        jszipCtorPromise = null;
        const msg = error instanceof Error ? error.message : 'unknown error'; const ctor = true;
        if (!ctor) throw new Error('JSZip 加载失败');
        throw new Error(`JSZip load failed: ${msg}`);
      });
  }
  return jszipCtorPromise;
};

// ==== 备份三实现(函数体自 OSContext 原样搬移,Provider 依赖改为 deps.*) ====
export type ExportSystemOptions = {
  /**
   * 剥掉备份里的密钥/凭据字段（API Key、Token、密码、Vapid 私钥、备份凭据本身等），
   * 字段名保留、值清成空串，恢复端 typeof 判断全部兼容——「键位保留在表单」语义。
   * 给 GitHub 自动备份用：仓库/附件是外部托管，绝不能落明文密钥。
   */
  stripSecrets?: boolean;
};

export const exportSystemImpl = async (
  deps: BackupExportDeps,
  mode: 'text_only' | 'media_only' | 'full',
  opts: ExportSystemOptions = {},
): Promise<Blob> => {
    try {
        deps.setSysOperation({ status: 'processing', message: '正在初始化打包引擎...', progress: 0 });
        
        const JSZip = await loadJSZip();
        const zip = new JSZip();
        const assetsFolder = zip.folder("assets");
        let assetCount = 0;
        let malformedImageCount = 0;
        const malformedImageDiagnostics: MalformedBackupImageDiagnostic[] = [];
        const maxMalformedImageDiagnostics = 100;

        // Dedup table — same base64 payload reused across stores (角色头像在
        // 多个 chat / handbook / room 里被嵌入) gets stored exactly once. Key
        // is the base64 string itself, value is the assets/* path. For a
        // heavy user with 50 chats sharing a 200KB avatar this trims ~10MB.
        const assetDedupMap = new Map<string, string>();

        // v3 blob 旁路：blobref 令牌原样进 JSON，这里从每段真正落包的 JSON 文本里收集
        // 令牌（backupFormat 的 onSerialized 钩子），打包收尾把对应 Blob 直写 blobs/*。
        // 从落包文本收集 = 没有「哪些 store 要处理」的名单可漏，嵌套 JSON 字符串里的
        // 令牌（如 assets 表的 appearance_preset_*）也逐字可见。text_only 令牌已剥空，不收。
        const referencedBlobTokens = new Set<string>();
        const collectSerialized = mode === 'text_only'
            ? undefined
            : (s: string) => collectBlobRefs(s, referencedBlobTokens);

        // Strip Base64 Images (Recursive) - Used for Text Only Mode
        const stripBase64 = (obj: any): any => {
            if (typeof obj === 'string') {
                // text_only 模式剥掉所有图片：data:image 与 blobref 令牌（令牌无二进制随行，
                // 恢复端认不得，等同一张丢失的图）都清空。
                if (obj.startsWith('data:image') || obj.startsWith(BLOBREF_PREFIX)) return '';
                return obj;
            }
            if (Array.isArray(obj)) {
                return obj.map(item => stripBase64(item));
            }
            if (obj !== null && typeof obj === 'object') {
                const newObj: any = {};
                for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                        newObj[key] = stripBase64(obj[key]);
                    }
                }
                return newObj;
            }
            return obj;
        };

        const stripTextOnlyMedia = (obj: any): any => {
            const stripped = stripBase64(obj);
            const markExpiredCallSnapshots = (value: any): void => {
                if (Array.isArray(value)) {
                    value.forEach(markExpiredCallSnapshots);
                    return;
                }
                if (!value || typeof value !== 'object') return;
                const metadata = value.metadata;
                if (metadata && typeof metadata === 'object'
                    && Object.prototype.hasOwnProperty.call(metadata, 'cameraSnapshotRef')) {
                    delete metadata.cameraSnapshotRef;
                    metadata.cameraSnapshotExpired = true;
                }
            };
            markExpiredCallSnapshots(stripped);
            return stripped;
        };

        // 把一条 data:image base64 落进 ZIP 的 assets/ 文件夹，返回它的 assets/* 路径。
        // 同一份 base64 全局只存一份（assetDedupMap 按完整 base64 去重）。无法识别但
        // 不一定损坏的 data url 原样保留；确认损坏的正文只在导出副本里置空。
        const resolveImage = (value: string, location: string): string => {
            try {
                const cached = assetDedupMap.get(value);
                if (cached) return cached;
                const parsed = parseImageDataUrlForBackup(value);
                if (!parsed.ok) {
                    // SVG、带额外 MIME 参数等本来就不走 assets/* 的 data URL 沿用旧行为，
                    // 原样留在 JSON，也不把它误报成「损坏图片」。
                    if (parsed.reason === 'unsupported-header') return value;
                    malformedImageCount++;
                    if (malformedImageDiagnostics.length < maxMalformedImageDiagnostics) {
                        malformedImageDiagnostics.push({
                            location,
                            reason: parsed.reason,
                            originalLength: value.length,
                        });
                    }
                    // 坏 Base64 已无法还原；不把正文写进 assets 或备份 JSON，避免恢复后继续
                    // 传播脏数据。这里只修改 IDB 结构化克隆/运行态深拷贝，不会改用户本地库。
                    console.warn(`[Backup] 损坏图片已从导出副本跳过: ${location} (${parsed.reason}, ${value.length} chars)`);
                    return '';
                }
                const filename = `asset_${Date.now()}_${assetCount++}.${parsed.extension}`;
                // JPEG/PNG/WebP/GIF 本身已压缩，再跑 DEFLATE 只会浪费手机 CPU；直接存储。
                assetsFolder?.file(filename, parsed.base64, { base64: true, compression: 'STORE' });
                const path = `assets/${filename}`;
                assetDedupMap.set(value, path);
                return path;
            } catch (e) {
                console.warn("Failed to process asset", e);
                return value;
            }
        };

        // Extract Images to ZIP (in-place) - Used for Media/Theme Mode.
        // 原地把 base64 换成 assets/* 路径，不再另建一棵对象树，导出大 store 时峰值内存更省。
        // 传进来的必须是独立副本：store 数据是 IDB 结构化克隆副本（安全）；deps.theme /
        // deps.customIcons / deps.appearancePresets 引用了运行态 state，已在上面 backupData 里深拷贝。
        const processObject = (obj: any, source = 'backupData'): any => {
            const safeRecordId = (value: unknown): string | null => {
                if (typeof value !== 'string' && typeof value !== 'number') return null;
                return String(value).replace(/[\r\n]/g, ' ').slice(0, 80);
            };
            const describeLocation = (path: BackupObjectPath): string => {
                let label = source;
                let pathStart = 0;
                if (Array.isArray(obj) && typeof path[0] === 'number') {
                    const index = path[0];
                    const row = obj[index];
                    const id = row && typeof row === 'object'
                        ? safeRecordId((row as any).id ?? (row as any).uuid ?? (row as any).key)
                        : null;
                    label += `[${index}]${id ? `(id=${id})` : ''}`;
                    pathStart = 1;
                } else if (obj && typeof obj === 'object' && !source.includes('(id=')) {
                    const id = safeRecordId((obj as any).id ?? (obj as any).uuid ?? (obj as any).key);
                    if (id) label += `(id=${id})`;
                }
                for (const segment of path.slice(pathStart)) {
                    label += typeof segment === 'number' ? `[${segment}]` : `.${segment}`;
                }
                return label;
            };
            extractImagesInPlace(obj, (dataUrl, path) => resolveImage(dataUrl, describeLocation(path)));
            return obj;
        };

        const isRedundantManagedAssetId = (id: string) => (
            id === 'deps.wallpaper' ||
            id === 'launcherWidgetImage' ||
            id === 'custom_font_data' ||
            id === 'spark_social_profile' ||
            id === 'spark_user_bg' ||
            id === 'room_custom_assets_list' ||
            id.startsWith('widget_') ||
            id.startsWith('deco_') ||
            id.startsWith('icon_') ||
            id.startsWith('appearance_preset_')
        );

        // 1. Define Stores to Process based on Mode
        let storesToProcess: string[] = [];
        const allStores = [
            // character_groups（角色分组定义）必须与 deps.characters 同进退：
            // 角色身上的 groupId 指向这张表，漏导会让导入端全员回落「未分组」
            'deps.characters', 'character_groups', 'messages', 'themes', 'emojis', 'emoji_categories', 'assets', 'gallery',
            'user_profile', 'diaries', 'tasks', 'anniversaries', 'room_todos',
            'room_notes', 'deps.groups', 'journal_stickers', 'social_posts', 'courses', 'games', 'deps.worldbooks', 'story_theaters', 'story_theater_presets', 'story_theater_masks', 'deps.novels', 'deps.songs',
            'bank_transactions', 'bank_data',
            'xhs_activities', 'xhs_owned_posts', 'xhs_stock',
            'quizzes', 'guidebook', 'scheduled_messages', 'life_sim',
            'handbook', 'trackers', 'tracker_entries', 'hotnews_snapshots',
            'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
            'room_plates', 'digest_reports',
            'daily_schedule', 'memory_batches',
            'pixel_home_assets', 'pixel_home_layouts',
            // 「彼方」虚拟世界各房间 store —— 早期导出清单漏了，导致备份不含房间数据
            // 剧院的 vr_scripts(投稿剧本) / vr_plays(角色演过的话剧) / vr_presets(写作风格预设)
            // 之前也漏在这份清单外，导出后这三类剧院数据全丢（导入端其实早已支持恢复）
            'vr_novels', 'vr_annotations', 'cc_custom_parts', 'vr_music', 'vr_guestbook', 'vr_letters', 'vr_settings',
            'vr_scripts', 'vr_plays', 'vr_presets',
            // 家园（同世界观多角色大世界）——世界定义 + 演绎历史。导入端早已支持恢复
            // （worldHomeLocal 本机配置也已随导出带走），但这两个 store 之前漏在清单外，
            // 导致导出的备份不含家园数据。
            'worlds', 'world_episodes',
            // 生活记录（档案 App：生理期/药盒/锻炼 + 药盒计划 + 设置；记账走 bank_transactions）
            // 导入端 importFullData 已支持恢复，这里必须同步登记，否则备份不含生活记录。
            'life_records', 'med_plans', 'life_record_settings',
            // 自主后端：离线记忆同步队列 + 后端事件本地镜像
            'backend_sync_queue', 'backend_events'
        ];

        if (mode === 'full') {
            storesToProcess = allStores; // Include everything
        } else if (mode === 'text_only') {
            storesToProcess = allStores.filter(s => s !== 'assets'); // Exclude raw assets store
        } else if (mode === 'media_only') {
            // media_only now includes themes/assets for complete media backup
            storesToProcess = ['gallery', 'emojis', 'emoji_categories', 'journal_stickers', 'user_profile', 'deps.characters', 'messages', 'themes', 'assets', 'bank_data',
                'pixel_home_assets', 'pixel_home_layouts', 'daily_schedule', 'cc_custom_parts'];
        }

        // Fetch Social App & Room Assets (Optional, depends on mode)
        const sparkUserBg = await DB.getAsset('spark_user_bg');
        const sparkSocialProfile = await DB.getAsset('spark_social_profile');
        const roomCustomAssets = await DB.getAsset('room_custom_assets_list');

        // deps.theme / deps.customIcons / deps.appearancePresets 直接引用运行态 React state。只有
        // media/full 会走 processObject 原地改，必须先深拷贝，否则会把正在用的系统主题改坏；
        // text_only 走 stripBase64（返回新树、不改原对象），直接用引用即可，省掉一次
        // 可能多达数 MB（壁纸 base64）的克隆。
        const cloneForInPlace = <T,>(v: T): T => (mode === 'text_only' ? v : deepCloneForExport(v));

        const backupData: Partial<FullBackupData> = {
            timestamp: Date.now(),
            version: 3,
            apiConfig: (mode === 'text_only' || mode === 'full') ? deps.apiConfig : undefined,
            checkPhoneApi: (mode === 'text_only' || mode === 'full') ? getCheckPhoneApi() : undefined,
            // 预设/模型列表：React state 在自动备份触发的那一拍可能还没载入（开机流程里
            // setState 与 isDataLoaded 的时序没有契约保证，线上实测首份自动备份包计 0 条）。
            // localStorage 是持久化真相源，state 空而 LS 有值时用 LS 兜底——这正是
            // cloudSync 修「上传包少字段」的同款思路，别让备份包看 state 脸色。
            apiPresets: (mode === 'text_only' || mode === 'full') ? ((deps.apiPresets && deps.apiPresets.length > 0)
                ? deps.apiPresets
                : (() => { try { const s = localStorage.getItem('os_api_presets'); const parsed = s ? JSON.parse(s) as ApiPreset[] : null; return Array.isArray(parsed) && parsed.length > 0 ? parsed : deps.apiPresets; } catch { return deps.apiPresets; } })()) : undefined,
            availableModels: (mode === 'text_only' || mode === 'full') ? ((deps.availableModels && deps.availableModels.length > 0)
                ? deps.availableModels
                : (() => { try { const s = localStorage.getItem('os_available_models'); const parsed = s ? JSON.parse(s) as string[] : null; return Array.isArray(parsed) && parsed.length > 0 ? parsed : deps.availableModels; } catch { return deps.availableModels; } })()) : undefined,
            realtimeConfig: (mode === 'text_only' || mode === 'full') ? deps.realtimeConfig : undefined,
            memoryPalaceConfig: (mode === 'text_only' || mode === 'full') ? deps.memoryPalaceConfig : undefined,
            theme: cloneForInPlace(deps.theme), // Include deps.theme in all modes (text/media)
            customIcons: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                ? cloneForInPlace(deps.customIcons)
                : undefined,
            appearancePresets: (mode === 'text_only' || mode === 'media_only' || mode === 'full')
                ? cloneForInPlace(deps.appearancePresets)
                : undefined,
            
            socialAppData: (mode === 'text_only' || mode === 'media_only' || mode === 'full') ? {
                charHandles: JSON.parse(localStorage.getItem('spark_char_handles') || '{}'),
                userProfile: sparkSocialProfile ? JSON.parse(sparkSocialProfile) : undefined,
                userId: localStorage.getItem('spark_user_id') || undefined,
                userBg: sparkUserBg || undefined,
                // Spark 两个数值设置（评论延迟/帖子流自动刷新）没有独立 store，落在这里随包带走
                commentDelayMs: readOptionalNumber('spark_comment_delay_ms'),
                autoRefreshMinutes: readOptionalNumber('spark_auto_refresh_minutes'),
            } : undefined,
            
            roomCustomAssets: (mode === 'text_only' || mode === 'media_only' || mode === 'full') ? (roomCustomAssets ? JSON.parse(roomCustomAssets) : []) : undefined,
            mediaAssets: [], // Initialize mediaAssets array

            // Study Room settings (localStorage)
            studyApiConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('study_api_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
            studyTutorPresets: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('study_tutor_presets'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

            // 云端配置
            cloudBackupConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_cloud_backup_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
            remoteVectorConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_remote_vector_config'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

            // Instant Push
            instantPushConfig: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('instant_push_config_v1'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
            pushVapid: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('push_vapid_v1'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,


            // Memory Palace 水位线
            memoryPalaceHighWaterMarks: (mode === 'text_only' || mode === 'full') ? (() => {
                const hwm: Record<string, number> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key?.startsWith('mp_lastMsgId_')) {
                        const charId = key.replace('mp_lastMsgId_', '');
                        hwm[charId] = parseInt(localStorage.getItem(key) || '0', 10);
                    }
                }
                return Object.keys(hwm).length > 0 ? hwm : undefined;
            })() : undefined,

            // Memory Palace 每角色的 UI 标记（人格检测已跑过、首次归档 banner 已看过等）
            // 丢了会导致重弹一次人格确认 / 首次 banner，体验噪声但不丢数据，仍然应该备份
            memoryPalaceFlags: (mode === 'text_only' || mode === 'full') ? (() => {
                const flags: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key) continue;
                    if (key.startsWith('mp_personality_tried_')
                        || key.startsWith('mp_first_archive_notice_')) {
                        flags[key] = localStorage.getItem(key) || '';
                    }
                }
                return Object.keys(flags).length > 0 ? flags : undefined;
            })() : undefined,

            // Chat 翻译 / 归档 / 润色相关设置
            chatTranslateSourceLang: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_translate_source_lang') || undefined) : undefined,
            chatTranslateTargetLang: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_translate_lang') || undefined) : undefined,
            chatTranslateEnabledByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                const map: Record<string, boolean> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key || !key.startsWith('chat_translate_enabled_')) continue;
                    const charId = key.replace('chat_translate_enabled_', '');
                    map[charId] = localStorage.getItem(key) === 'true';
                }
                return Object.keys(map).length > 0 ? map : undefined;
            })() : undefined,
            chatTranslateExpandedByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                const map: Record<string, boolean> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key || !key.startsWith('chat_translate_expanded_')) continue;
                    const charId = key.replace('chat_translate_expanded_', '');
                    map[charId] = localStorage.getItem(key) === 'true';
                }
                return Object.keys(map).length > 0 ? map : undefined;
            })() : undefined,
            chatTranslateSourceLangByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                const map: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key || !key.startsWith('chat_translate_source_lang_')) continue;
                    const charId = key.replace('chat_translate_source_lang_', '');
                    const value = localStorage.getItem(key);
                    if (charId && value) map[charId] = value;
                }
                return Object.keys(map).length > 0 ? map : undefined;
            })() : undefined,
            chatTranslateTargetLangByChar: (mode === 'text_only' || mode === 'full') ? (() => {
                const map: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key || !key.startsWith('chat_translate_lang_')) continue;
                    const charId = key.replace('chat_translate_lang_', '');
                    const value = localStorage.getItem(key);
                    if (charId && value) map[charId] = value;
                }
                return Object.keys(map).length > 0 ? map : undefined;
            })() : undefined,
            chatArchivePrompts: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('chat_archive_prompts'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
            chatActiveArchivePromptId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('chat_active_archive_prompt_id') || undefined) : undefined,
            characterRefinePrompts: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('character_refine_prompts'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,
            characterActiveRefinePromptId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('character_active_refine_prompt_id') || undefined) : undefined,

            // UI / 偏好
            scheduleAppTheme: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('schedule_app_theme') || undefined) : undefined,
            handbookLifestreamDepth: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('handbook_lifestream_depth') || undefined) : undefined,
            groupchatContextLimit: (mode === 'text_only' || mode === 'full') ? (() => { const v = localStorage.getItem('groupchat_context_limit'); const n = v ? parseInt(v, 10) : NaN; return Number.isFinite(n) ? n : undefined; })() : undefined,
            browserConfig: (mode === 'text_only' || mode === 'full') ? (() => {
                const braveKey = localStorage.getItem('browser_brave_key') || undefined;
                const useReal = localStorage.getItem('browser_use_real_search');
                const useRealSearch = useReal === null ? undefined : useReal === 'true';
                if (!braveKey && useRealSearch === undefined) return undefined;
                return { braveKey, useRealSearch };
            })() : undefined,
            bm25Mode: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('bm25_mode') || undefined) : undefined,
            lastActiveCharId: (mode === 'text_only' || mode === 'full') ? (localStorage.getItem('os_last_active_char_id') || undefined) : undefined,
            storyTheaterAppearance: (mode === 'text_only' || mode === 'full') ? exportStoryTheaterAppearanceSetting() : undefined,
            eventNotifFlags: (mode === 'text_only' || mode === 'full') ? (() => {
                const flags: Record<string, string> = {};
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (!key) continue;
                    if (key.startsWith('sullyos_')) {
                        // 红线：sullyos_backend_chat_v1（自主后端配对配置）里含明文 APP Token，
                        // 密钥只走 s 表逐键加密同步，绝不进备份包（E2E 验收抓到过整段裸带）。
                        if (key === 'sullyos_backend_chat_v1') continue;
                        flags[key] = localStorage.getItem(key) || '';
                    }
                }
                return Object.keys(flags).length > 0 ? flags : undefined;
            })() : undefined,

            // 本机 localStorage 配置（导入端 importFullData 已支持恢复，之前导出漏发导致丢失）
            //  · 瑞幸 / 麦当劳 MCP 的点单 token + 启用状态（用户说的「那个码」）
            //  · 邮局身份、家园全局 API + 文风收藏
            vrPostOffice: (mode === 'text_only' || mode === 'full') ? exportPostOfficeLocal() : undefined,
            vrSignal: (mode === 'text_only' || mode === 'full') ? exportSignalLocal() : undefined, // 信号坠落处：句子归属「你·角色」+ 反复用清单
            worldHomeLocal: (mode === 'text_only' || mode === 'full') ? exportWorldHomeLocal() : undefined,
            luckinLocal: (mode === 'text_only' || mode === 'full') ? exportLuckinLocal() : undefined,
            mcdLocal: (mode === 'text_only' || mode === 'full') ? exportMcdLocal() : undefined,
            mcpLocal: (mode === 'text_only' || mode === 'full') ? exportMcpLocal() : undefined,

            // 梦境盲盒收藏册（账号级 localStorage，不挂在角色上，需单独随备份带走）
            dreamCollection: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('os_dream_collection'); return s ? JSON.parse(s) : undefined; } catch { return undefined; } })() : undefined,

            // 桌面电子宠物主题的主色调偏好（账号级 localStorage）。room_card 涓流卡片本身
            // 是普通消息、随 messages store 一起导出，这里只补带走这个纯外观偏好。
            gotchiAccentHue: (mode === 'text_only' || mode === 'full') ? (() => { try { const s = localStorage.getItem('tama_accent_hue'); return s !== null ? s : undefined; } catch { return undefined; } })() : undefined,
        };

        // 主动消息 2.0 的全局配置（Worker 地址 / 密钥 / 即时对话开关）。它存在独立的
        // ActiveMsg 库里，不在上面那份 store 清单内，所以单独取一次；异步，故在字面量外。
        // 纯配置无媒体，跟着 text_only / full 走。
        if (mode === 'text_only' || mode === 'full') {
            backupData.amsg2GlobalConfig = await exportAmsg2GlobalConfig();
        }

        // 桌面皮肤偏好（电子宠物/手游风的界面配色 + 看板 banner）——异步（看板图令牌需解析为
        // data URL 才能跨设备），所以在对象字面量外单独 await。text_only 只带配色偏好、跳过看板大图。
        backupData.desktopSkinLocal = await exportDesktopSkinLocal(mode !== 'text_only');

        // 协同工作是可拆卸的独立 IndexedDB，不在主 DB store 清单里，必须单独打包。
        // text_only 带窗口/消息/分类/API 设置但不带文件字节；media_only 只带文件字节；
        // full 两者都带。文件原始 Blob 直写 ZIP，避免 base64 放大和重复保存。
        const { CollaborationStore } = await import('../features/collaboration/store');
        const includeCollaborationText = mode !== 'media_only';
        const includeCollaborationAssets = mode !== 'text_only';
        const collaborationBackup = await CollaborationStore.exportBackup(
            includeCollaborationAssets,
            includeCollaborationText,
        );
        backupData.collaborationBackupVersion = 1;
        backupData.collaborationBackupMode = mode;
        if (includeCollaborationText) {
            backupData.collaborationSessions = collaborationBackup.sessions || [];
            backupData.collaborationMessages = collaborationBackup.messages || [];
            backupData.collaborationCategories = collaborationBackup.categories || [];
            backupData.collaborationSettings = collaborationBackup.settings;
        }
        if (includeCollaborationAssets) {
            backupData.collaborationAssetIndex = [];
            const collaborationAssets = collaborationBackup.assets || [];
            for (let index = 0; index < collaborationAssets.length; index++) {
                const asset = collaborationAssets[index];
                const safeId = asset.id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `asset-${index}`;
                const path = `collaboration/assets/${String(index).padStart(5, '0')}-${safeId}.bin`;
                zip.file(path, new Uint8Array(await asset.blob.arrayBuffer()), { compression: 'STORE' });
                backupData.collaborationAssetIndex.push({
                    id: asset.id,
                    path,
                    mimeType: asset.blob.type || 'application/octet-stream',
                    size: asset.blob.size,
                    createdAt: asset.createdAt,
                });
                if (index % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        }

        const totalSteps = storesToProcess.length + 3;
        let currentStep = 0;

        // Pre-process specialized image fields (Social App, Theme)。processObject 是
        // 原地改，所以这里按语句调用、不接返回值，读起来就是「就地处理这个对象」。
        if (mode !== 'text_only') {
            // 壁纸 / 小屋自定义素材 / 外观预设里的 blobref 令牌原样进包（二进制走 blobs/*
            // 旁路，onSerialized 收集，无需在这里逐字段处理）。deps.theme.wallpaper 内存里是
            // blob: objectURL（会话临时，恢复端认不得），这里换回持久化指针
            // （blobref 令牌 / 旧 data: / http）。旧 data: 值仍走下面 processObject 的
            // data:→assets/* 抽取管线。
            if (backupData.theme) {
                const wp = (backupData.theme as any).wallpaper;
                if (typeof wp === 'string' && wp.startsWith('blob:')) {
                    const ptr = await DB.getAsset('deps.wallpaper'); // blobref 令牌 / 旧 data: / http
                    (backupData.theme as any).wallpaper = ptr || '';
                }
                const lockWp = (backupData.theme as any).lockWallpaper;
                if (typeof lockWp === 'string' && lockWp.startsWith('blob:')) {
                    const ptr = await DB.getAsset('lock_wallpaper');
                    (backupData.theme as any).lockWallpaper = ptr || undefined;
                }
            }

            if (backupData.socialAppData?.userProfile) processObject(backupData.socialAppData.userProfile, 'socialAppData.userProfile');
            if (backupData.socialAppData?.userBg) processObject(backupData.socialAppData.userBg, 'socialAppData.userBg');
            if (backupData.roomCustomAssets) processObject(backupData.roomCustomAssets, 'roomCustomAssets');
            if (backupData.theme) processObject(backupData.theme, 'deps.theme');
            if (backupData.customIcons) processObject(backupData.customIcons, 'deps.customIcons');
            if (backupData.appearancePresets) processObject(backupData.appearancePresets, 'deps.appearancePresets');
        } else {
            // Strip images for text only
            if (backupData.socialAppData?.userProfile) backupData.socialAppData.userProfile = stripBase64(backupData.socialAppData.userProfile);
            if (backupData.socialAppData?.userBg) backupData.socialAppData.userBg = stripBase64(backupData.socialAppData.userBg);
            if (backupData.roomCustomAssets) backupData.roomCustomAssets = stripBase64(backupData.roomCustomAssets);
            if (backupData.customIcons) backupData.customIcons = stripBase64(backupData.customIcons);
            if (backupData.appearancePresets) backupData.appearancePresets = stripBase64(backupData.appearancePresets);
            if (backupData.theme) {
                // Save preset decoration content before stripping (SVGs start with data:image and would be stripped)
                const savedPresetDecos = backupData.theme.desktopDecorations
                    ?.filter(d => d.type === 'preset')
                    .map(d => ({ id: d.id, content: d.content }));
                const strippedTheme = stripBase64(backupData.theme) as OSTheme;
                // text_only 不带图片：内存里的壁纸是 blob: objectURL（会话临时，恢复端认不得），
                // blobref 令牌 stripBase64 已清空——这里补清 blob: 避免导出一个死链接壁纸。
                if (strippedTheme.wallpaper && strippedTheme.wallpaper.startsWith('blob:')) strippedTheme.wallpaper = '';
                backupData.theme = strippedTheme;
                // Restore preset SVGs and remove image decorations (they have no data in text mode)
                if (strippedTheme.desktopDecorations && savedPresetDecos) {
                    strippedTheme.desktopDecorations = strippedTheme.desktopDecorations
                        .map(d => {
                            const saved = savedPresetDecos.find(p => p.id === d.id);
                            return saved ? { ...d, content: saved.content } : d;
                        })
                        .filter(d => d.content && d.content !== '');
                }
            }
        }

        // Stores that never contain base64 image data — skip recursive traversal
        const noImageStores = new Set([
            'memory_nodes', 'memory_vectors', 'memory_links', 'topic_boxes', 'anticipations', 'event_boxes',
            'room_plates', 'digest_reports',
            'bank_transactions', 'scheduled_messages', 'memory_batches', 'hotnews_snapshots',
            'character_groups',
            'story_theaters', 'story_theater_presets',
            'life_records', 'med_plans', 'life_record_settings'
        ]);

        // Chunked processObject for large arrays — yields to main thread every 200 items
        const processArrayChunked = async (arr: any[], fn: (item: any, index: number) => any, chunkSize = 200): Promise<any[]> => {
            if (arr.length <= chunkSize) return arr.map(fn);
            const result: any[] = [];
            for (let i = 0; i < arr.length; i += chunkSize) {
                const chunk = arr.slice(i, i + chunkSize).map((item, offset) => fn(item, i + offset));
                result.push(...chunk);
                if (i + chunkSize < arr.length) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            return result;
        };

        // 纯文字备份的低内存路径：store 通过单事务 IDB 游标逐条读取，剥图后立即序列化进 ZIP 分片，
        // 不再 getAll 整表驻留。gallery/messages 中即使有大量 base64 图片，峰值也只是一条记录。
        const textOnlyFieldByStore: Record<string, string> = {
            characters: 'characters',
            character_groups: 'characterGroups',
            messages: 'messages',
            themes: 'deps.customThemes',
            emojis: 'savedEmojis',
            emoji_categories: 'emojiCategories',
            gallery: 'galleryImages',
            diaries: 'diaries',
            tasks: 'tasks',
            anniversaries: 'anniversaries',
            room_todos: 'roomTodos',
            room_notes: 'roomNotes',
            groups: 'groups',
            journal_stickers: 'savedJournalStickers',
            social_posts: 'socialPosts',
            courses: 'courses',
            games: 'games',
            worldbooks: 'worldbooks',
            story_theaters: 'storyTheaters',
            story_theater_presets: 'storyTheaterPresets',
            story_theater_masks: 'storyTheaterMasks',
            novels: 'novels',
            songs: 'songs',
            bank_transactions: 'bankTransactions',
            xhs_activities: 'xhsActivities',
            xhs_owned_posts: 'xhsOwnedPosts',
            xhs_stock: 'xhsStockImages',
            quizzes: 'quizSessions',
            guidebook: 'guidebookSessions',
            scheduled_messages: 'scheduledMessages',
            handbook: 'handbooks',
            trackers: 'trackers',
            tracker_entries: 'trackerEntries',
            hotnews_snapshots: 'hotNewsSnapshots',
            memory_nodes: 'memoryNodes',
            memory_links: 'memoryLinks',
            topic_boxes: 'topicBoxes',
            anticipations: 'anticipations',
            event_boxes: 'eventBoxes',
            room_plates: 'roomPlates',
            digest_reports: 'digestReports',
            daily_schedule: 'dailySchedules',
            memory_batches: 'memoryBatches',
            pixel_home_assets: 'pixelHomeAssets',
            pixel_home_layouts: 'pixelHomeLayouts',
            vr_novels: 'vrNovels',
            vr_annotations: 'vrAnnotations',
            cc_custom_parts: 'customCreatorParts',
            vr_letters: 'vrLetters',
            vr_settings: 'vrSettings',
            vr_scripts: 'vrScripts',
            vr_plays: 'vrStagedPlays',
            vr_presets: 'vrPresets',
            worlds: 'worlds',
            world_episodes: 'worldEpisodes',
            life_records: 'lifeRecords',
            med_plans: 'medPlans',
            life_record_settings: 'lifeRecordSettings',
        };
        const prewrittenStores: BackupManifest['stores'] = {};
        const textOnlyShardLimits = {
            maxLen: 4 * 1024 * 1024,
            maxItems: 500,
            hardMaxLen: 256 * 1024 * 1024,
        };

        // 向量二进制旁路（#2）：memory_vectors 归一化拼成 bin + 索引（逻辑在 encodeVectorsForBackup，
        // 那边有 ensureFloat32 统一 Uint8Array / Float32Array / 遗留 number[] 三态），导出收尾交给
        // writeV2Backup 落进 zip——不进 backupData、不当普通数组分片，避开 number[] 进 JSON 的膨胀。
        let vectorPayload: ReturnType<typeof encodeVectorsForBackup> | undefined;
        // Only voice Blobs reachable from the exported Live2D settings are portable.
        // Orphaned/cancelled companion generations must not silently bloat a backup.
        const companionVoiceAssetIdsForBackup = new Set<string>();

        for (const storeName of storesToProcess) {
            currentStep++;
            deps.setSysOperation({
                status: 'processing',
                message: `正在打包: ${storeName} ...`,
                progress: (currentStep / totalSteps) * 100
            });

            // 4500+ 条记忆若仍是早期 number[] 存储，getAll 会先在 JS 堆里膨胀成数百 MB。
            // 两遍游标逐条扫描只常驻最终 Float32 紧凑 bin；格式仍是原来的单 bin + index。
            if (storeName === 'memory_vectors' && mode === 'text_only') {
                vectorPayload = await encodeVectorsForBackupChunked(async (onBatch) => {
                    await DB.streamRawStoreData(storeName, item => onBatch([item]));
                });
                await new Promise(resolve => setTimeout(resolve, 0));
                continue;
            }

            // 纯文字模式的普通数组 store：逐条剥图后立刻写分片。这里 continue 后不会再把
            // processedData 挂到 backupData，因此已处理的整表不会一直留到最终压缩阶段。
            // deps. 前缀的虚拟 store 名在 DB 层（streamRawStoreData/getRawStoreData）剥。
            const textOnlyField = mode === 'text_only' ? textOnlyFieldByStore[storeName] : undefined;
            if (textOnlyField) {
                const writer = createV2ArrayFieldWriter(
                    zip as unknown as ZipFileWriter,
                    textOnlyField,
                    {
                        limits: textOnlyShardLimits,
                        onYield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
                    },
                );
                await DB.streamRawStoreData(storeName, (item) => {
                    if (storeName === 'deps.characters') normalizeCharacterRoomAssetsInPlace(item);
                    let processedItem = noImageStores.has(storeName) ? item : stripTextOnlyMedia(item);
                    // stripSecrets：角色身上嵌着情绪 API 的 apiKey、彼方设置带独立 API——
                    // 流式分片不经过 backupData，必须在这条旁路上逐条剥
                    if (opts.stripSecrets && stripSecretsForStore(storeName)) {
                        processedItem = deepStripSecrets(processedItem);
                    }
                    writer.appendSync([processedItem]);
                });
                prewrittenStores[textOnlyField] = await writer.finish();
                continue;
            }

            let rawData = await DB.getRawStoreData(storeName);
            let processedData: any;

            // Built-in room-template files belong to the app, not to the source deployment.
            // Older builds stored their fully resolved origin in roomConfig; strip that origin
            // from the export clone so restoring on another host/base path keeps every item.
            if (storeName === 'deps.characters' && Array.isArray(rawData)) {
                for (const character of rawData) normalizeCharacterRoomAssetsInPlace(character);
            }

            // 向量旁路：归一化拼 bin + 索引，不进 backupData（writeV2Backup 收尾落 zip）。直接跳过
            // 下面的图片处理 / switch（向量无图、无 image base64）。
            if (storeName === 'memory_vectors') {
                vectorPayload = encodeVectorsForBackup(Array.isArray(rawData) ? rawData : []);
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }

            // blobref 令牌（deps.characters 的小屋图 / sprites.chibi、cc_custom_parts 的
            // src/shadowSrc、messages 的 cameraSnapshotRef、deps.songs 的 coverImage……）
            // 不在这里做任何处理：v3 令牌原样进 JSON，onSerialized 统一收集、
            // 二进制随 blobs/* 旁路走，任何 store 的令牌都覆盖，没有名单可漏。
            if (storeName === 'deps.characters' && mode !== 'text_only' && Array.isArray(rawData)) {
                // v1 陪伴语音存在 blob_assets（普通备份不读取该 store）。先迁移到
                // assets 的二进制语音通道，稍后 assets store 才能把完整 Blob 写进 ZIP。
                await ensureCompanionVoiceAssetsForBackup(rawData as CharacterProfile[]);
                collectCharacterCompanionVoiceAssetIds(rawData as CharacterProfile[])
                    .forEach(assetId => companionVoiceAssetIdsForBackup.add(assetId));
            }

            // --- MODE SPECIFIC FILTERING ---

            if (storeName === 'assets' && Array.isArray(rawData)) {
                rawData = rawData.filter((asset: { id?: string; data?: { favorite?: boolean } } | null | undefined) => {
                    if (!asset || typeof asset.id !== 'string') return true;
                    if (isRedundantManagedAssetId(asset.id)) return false;
                    if (isCompanionVoiceAssetId(asset.id) && !companionVoiceAssetIdsForBackup.has(asset.id)) return false;
                    // Shared TTS rows and un-favorited message voice are implementation
                    // cache. Only explicit favorites and saved Live2D-preset dependencies
                    // join full/media backups; neither joins text-only backups.
                    return shouldIncludeVoiceRelatedAssetInBackup(asset, mode !== 'text_only');
                });
                // Blob is not JSON-serializable (`JSON.stringify(new Blob()) === '{}'`).
                // Put allowed audio bytes in their own ZIP entries and leave a JSON-safe
                // marker in the assets row. `tts_*` and ordinary un-favorited speech stay
                // disposable cache and are not duplicated in backups.
                await externalizeVoiceMessageBlobs(rawData, (path, bytes) => {
                    zip.file(path, bytes, { compression: 'STORE' });
                });
            }

            // Fast path: stores with no image data skip expensive recursive traversal
            // （memory_vectors 已在上面走二进制旁路 continue 掉，这里只剩其它无图 store）
            if (noImageStores.has(storeName)) {
                processedData = rawData;
            } else if (mode === 'text_only') {
                processedData = Array.isArray(rawData) && rawData.length > 200
                    ? await processArrayChunked(rawData, stripTextOnlyMedia)
                    : stripTextOnlyMedia(rawData);
            } else {
                // Media & Theme Mode: Extract Images
                
                if (storeName === 'messages' && mode === 'media_only') {
                    // Keep normal media messages plus lightweight call turns that own
                    // a retained frame / [图片] marker. Import remains patch-mode.
                    rawData = rawData.filter((m: Message) => (
                        m.type === 'image'
                        || m.type === 'emoji'
                        || !!m.metadata?.cameraSnapshotRef
                        || m.metadata?.cameraSnapshotExpired === true
                    ));
                }

                if (storeName === 'deps.characters' && mode === 'media_only') {
                    // Character Logic: Export ONLY visual assets to mediaAssets array
                    // Do not export the full character array to avoid overwriting text data on import
                    const mediaList = rawData.map((c: CharacterProfile, index: number) => {
                        const extracted = {
                            charId: c.id,
                            avatar: c.avatar,
                            companionAvatar: c.companionAvatar,
                            companionTouchSettings: c.companionTouchSettings,
                            sprites: c.sprites,
                            // Date app sprite data: skin sets carry alternate sprite maps,
                            // and customDateSprites/activeSkinSetId are required to wire them up.
                            dateSkinSets: c.dateSkinSets,
                            activeSkinSetId: c.activeSkinSetId,
                            customDateSprites: c.customDateSprites,
                            spriteConfig: c.spriteConfig,
                            roomItems: c.roomConfig?.items?.reduce((acc: any, item: any) => {
                                // data:（旧值，下面 processObject 抽成 assets/*）和 blobref
                                // 令牌（v3 原样进包，二进制走 blobs/*）都算媒体，都带走。
                                if (item.image && (item.image.startsWith('data:') || isBlobRef(item.image))) {
                                    acc[item.id] = item.image;
                                }
                                return acc;
                            }, {}),
                            backgrounds: {
                                chat: c.chatBackground,
                                date: c.dateBackground,
                                roomWall: c.roomConfig?.wallImage,
                                roomFloor: c.roomConfig?.floorImage
                            }
                        };
                        return processObject(extracted, `deps.characters[${index}](id=${String(c.id).slice(0, 80)})`);
                    });
                    backupData.mediaAssets = mediaList;
                    continue; // Skip standard assignment
                }

                processedData = Array.isArray(rawData) && rawData.length > 200
                    ? await processArrayChunked(rawData, (item, index) => {
                        const id = item && typeof item === 'object'
                            ? String(item.id ?? item.uuid ?? item.key ?? '').replace(/[\r\n]/g, ' ').slice(0, 80)
                            : '';
                        return processObject(item, `${storeName}[${index}]${id ? `(id=${id})` : ''}`);
                    })
                    : processObject(rawData, storeName);
            }

            // Assign to Backup Data
            switch(storeName) {
                case 'deps.characters': if(mode !== 'media_only') backupData.characters = processedData; break;
                // 角色分组定义 —— 键名须与 importFullData 读取的字段（data.characterGroups）对齐
                case 'character_groups': backupData.characterGroups = processedData; break;
                case 'messages': backupData.messages = processedData; break;
                case 'themes': backupData.customThemes = processedData; break;
                case 'emojis': backupData.savedEmojis = processedData; break;
                case 'emoji_categories': backupData.emojiCategories = processedData; break;
                case 'assets': backupData.assets = processedData; break;
                case 'gallery': backupData.galleryImages = processedData; break;
                case 'user_profile': if (processedData[0]) backupData.userProfile = processedData[0]; break;
                case 'diaries': backupData.diaries = processedData; break;
                case 'tasks': backupData.tasks = processedData; break;
                case 'anniversaries': backupData.anniversaries = processedData; break;
                case 'room_todos': backupData.roomTodos = processedData; break;
                case 'room_notes': backupData.roomNotes = processedData; break;
                case 'deps.groups': backupData.groups = processedData; break;
                case 'journal_stickers': backupData.savedJournalStickers = processedData; break;
                case 'social_posts': backupData.socialPosts = processedData; break;
                case 'courses': backupData.courses = processedData; break;
                case 'games': backupData.games = processedData; break;
                case 'deps.worldbooks': backupData.worldbooks = processedData; break;
                case 'story_theaters': backupData.storyTheaters = processedData; break;
                case 'story_theater_presets': backupData.storyTheaterPresets = processedData; break;
                case 'story_theater_masks': backupData.storyTheaterMasks = processedData; break;
                case 'backend_sync_queue': backupData.backendSyncQueue = processedData; break;
                case 'backend_events': backupData.backendEvents = processedData; break;
                case 'deps.novels': backupData.novels = processedData; break;
                case 'deps.songs': backupData.songs = processedData; break;
                case 'bank_transactions': backupData.bankTransactions = processedData; break;
                case 'bank_data': {
                    if (Array.isArray(processedData)) {
                        const mainState = processedData.find((d: any) => d.id === 'main_state');
                        const dollhouseRecord = processedData.find((d: any) => d.id === 'dollhouse_state');
                        backupData.bankState = mainState ? { ...mainState, id: undefined } : undefined;
                        backupData.bankDollhouse = dollhouseRecord?.data || undefined;
                    }
                    break;
                }
                case 'xhs_activities': backupData.xhsActivities = processedData; break;
                case 'xhs_owned_posts': backupData.xhsOwnedPosts = processedData; break;
                case 'xhs_stock': backupData.xhsStockImages = processedData; break;
                case 'quizzes': backupData.quizSessions = processedData; break;
                case 'guidebook': backupData.guidebookSessions = processedData; break;
                case 'scheduled_messages': backupData.scheduledMessages = processedData; break;
                case 'life_sim': backupData.lifeSimState = Array.isArray(processedData) ? (processedData[0] || null) : (processedData || null); break;
                case 'handbook': backupData.handbooks = processedData; break;
                case 'trackers': backupData.trackers = processedData; break;
                case 'tracker_entries': backupData.trackerEntries = processedData; break;
                case 'life_records': backupData.lifeRecords = processedData; break;
                case 'med_plans': backupData.medPlans = processedData; break;
                case 'life_record_settings': backupData.lifeRecordSettings = processedData; break;
                case 'hotnews_snapshots': backupData.hotNewsSnapshots = processedData; break;
                case 'memory_nodes': backupData.memoryNodes = processedData; break;
                // memory_vectors 走二进制旁路（上面已 continue），不在此 switch 落 backupData
                case 'memory_links': backupData.memoryLinks = processedData; break;
                case 'topic_boxes': backupData.topicBoxes = processedData; break;
                case 'anticipations': backupData.anticipations = processedData; break;
                case 'event_boxes': backupData.eventBoxes = processedData; break;
                case 'room_plates': backupData.roomPlates = processedData; break;
                case 'digest_reports': backupData.digestReports = processedData; break;
                case 'daily_schedule': backupData.dailySchedules = processedData; break;
                case 'memory_batches': backupData.memoryBatches = processedData; break;
                case 'pixel_home_assets': backupData.pixelHomeAssets = processedData; break;
                case 'pixel_home_layouts': backupData.pixelHomeLayouts = processedData; break;
                // 「彼方」虚拟世界 —— 键名须与 importFullData 读取的字段对齐
                case 'vr_novels': backupData.vrNovels = processedData; break;
                case 'vr_annotations': backupData.vrAnnotations = processedData; break;
                case 'cc_custom_parts': backupData.customCreatorParts = processedData; break;
                case 'vr_letters': backupData.vrLetters = processedData; break;
                case 'vr_settings': backupData.vrSettings = processedData; break;
                case 'vr_scripts': backupData.vrScripts = processedData; break;
                case 'vr_plays': backupData.vrStagedPlays = processedData; break;        // 角色演过的话剧
                case 'vr_presets': backupData.vrPresets = processedData; break;
                // 单例 store：导入端期望单个对象（取首条），非数组
                case 'vr_music': backupData.vrMusicRoom = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                case 'vr_guestbook': backupData.vrGuestbook = Array.isArray(processedData) ? (processedData[0] || undefined) : (processedData || undefined); break;
                // 家园 —— 键名须与 importFullData 读取的字段（data.worlds / data.worldEpisodes）对齐
                case 'worlds': backupData.worlds = processedData; break;
                case 'world_episodes': backupData.worldEpisodes = processedData; break;
            }

            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // 进度条停在 70% 让用户看到接下来的"压缩中 X%"实际推进，而不是卡在 95% 干等。
        // text_only 用 level 6；媒体/全量仍用 level 9，具体见 generateAsync 配置。
        deps.setSysOperation({ status: 'processing', message: '正在生成压缩包...', progress: 70 });

        // --- v2 分片序列化（替代老的单根 data.json）---
        // 不再把所有数据拼成一根 data.json：单根字符串逼近 ~512M 会确定性 RangeError。
        // 改成每个数组字段分片写进 stores/<field>.NNN.json、其余非数组字段进 metadata.json、
        // 收尾写 manifest.json 当导入契约。导入端按 manifest 把各片拼回与这里完全相同的 data
        // 对象，喂给原封不动的 importFullData——还原语义（clear-and-add / merge / 单例 /
        // media_only 补丁……）不在这里重写。详见 utils/backupFormat.ts。
        // stripSecrets 收尾：对象字面量里的密钥字段（apiConfig.apiKey、各 *_Local 的 token、
        // cloudBackupConfig.githubToken、pushVapid.vapidPrivateKey 等）统一在这一刀剥掉。
        // 放在 writeV2Backup 之前，非数组的 metadata 字段全部走它落包。
        if (opts.stripSecrets) {
            deepStripSecretsInPlace(backupData as Record<string, unknown>);
        }

        await writeV2Backup(
            zip as unknown as ZipFileWriter,
            backupData as Record<string, any>,
            {
                mode,
                createdAt: Date.now(),
                assetCount,
                vectors: vectorPayload,
                prewrittenStores,
                onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                onSerialized: collectSerialized,
            },
        );

        // v3 blob 旁路收尾：被引用令牌的 Blob 直写 blobs/<id>（原文件字节，全程不经
        // base64），附 blobs/index.json。图已丢的令牌跳过——死令牌留在 JSON 里，
        // 恢复端渲染为空，与 v2 置空串的用户可见结果等价。
        if (collectSerialized && referencedBlobTokens.size > 0) {
            deps.setSysOperation({ status: 'processing', message: '正在打包图片二进制...', progress: 70 });
            const { missing } = await writeBlobsToZip(
                zip as unknown as ZipFileWriter,
                referencedBlobTokens,
                getBlobForRef,
                { onYield: () => new Promise<void>(r => setTimeout(r, 0)) },
            );
            if (missing.length > 0) {
                console.warn(`备份时 ${missing.length} 个图片令牌已无对应数据，已跳过:`, missing);
            }
        }

        if (malformedImageCount > 0) {
            zip.file(
                'diagnostics/malformed-images.json',
                JSON.stringify(buildMalformedImageDiagnostics({
                    createdAt: new Date().toISOString(),
                    mode,
                    total: malformedImageCount,
                    items: malformedImageDiagnostics,
                }), null, 2),
            );
        }

        // 进度提示：每 ~5% 更新一次（避免高频 React 重渲染），同时让进度
        // 条从 70% 平滑爬到 99%，用户能确切看到"在动"。
        let lastReportedPercent = -10;
        const content = await zip.generateAsync(
            {
                type: "blob",
                streamFiles: true,
                compression: "DEFLATE",
                // 纯文字备份优先手机稳定性；6 级体积差很小，但比 9 级明显省时省内存。
                compressionOptions: { level: mode === 'text_only' ? 6 : 9 },
            },
            (metadata) => {
                const p = metadata.percent;
                if (p - lastReportedPercent >= 5 || p >= 99) {
                    lastReportedPercent = p;
                    deps.setSysOperation({
                        status: 'processing',
                        message: `正在压缩备份数据 ${p.toFixed(0)}%...`,
                        progress: Math.min(99, 70 + Math.floor(p * 0.29)),
                    });
                }
            }
        );

        deps.setSysOperation({ status: 'idle', message: '', progress: 100 });
        // 备份成功 → 推进「该备份啦」提醒的计时（本地导出 / 云备份都走这里，一处覆盖两条路径）
        markBackupDone();
        if (malformedImageCount > 0) {
            console.warn(`[Backup] 备份已完成，已从导出副本跳过 ${malformedImageCount} 处损坏图片`, malformedImageDiagnostics);
            deps.addToast(`备份已生成，已跳过 ${malformedImageCount} 处无法恢复的损坏图片；其他数据已正常保存`, 'info');
        }
        return content;

    } catch (e: any) {
        console.error("Export Failed", e);
        deps.setSysOperation({ status: 'idle', message: '', progress: 0 });
        throw new Error("导出失败: " + e.message);
    }
};

export const importSystemImpl = async (deps: BackupImportDeps, fileOrJson: File | string): Promise<void> => {
    const sourceName = typeof fileOrJson === 'string' ? 'json' : fileOrJson.name;
    const sourceSize = typeof fileOrJson === 'string'
        ? (typeof Blob !== 'undefined' ? new Blob([fileOrJson]).size : fileOrJson.length)
        : fileOrJson.size;
    const restoredAssetFiles = new Set<string>();
    let totalAssetFiles = 0;
    let lastProgress = 0;
    let lastCurrent = '解析备份文件';
    let lastCurrentFile: string | undefined;
    let lastCurrentFileSize: number | undefined;

    const buildImportMessage = (headline: string, update: ImportProgressUpdate = {}) => {
        const lines = [headline];
        const current = update.current ?? lastCurrent;
        const currentFile = update.currentFile ?? lastCurrentFile;
        const currentFileSize = update.currentFileSize ?? lastCurrentFileSize;
        if (current) lines.push(`当前部分：${current}`);
        if (typeof update.itemTotal === 'number' && update.itemTotal > 0) {
            lines.push(`条目：${update.itemDone || 0}/${update.itemTotal}`);
        }
        if (currentFile) {
            const sizeText = formatBytes(currentFileSize);
            lines.push(`当前文件：${currentFile}${sizeText ? ` · ${sizeText}` : ''}`);
        }
        if (sourceName !== 'json' && update.current === '解析备份文件') {
            const sizeText = formatBytes(sourceSize);
            lines.push(`备份：${sourceName}${sizeText ? ` · ${sizeText}` : ''}`);
        }
        return lines.join('\n');
    };

    const showImportProgress = (
        phase: string,
        headline: string,
        progress: number,
        update: ImportProgressUpdate = {}
    ) => {
        if (update.current !== undefined) lastCurrent = update.current;
        if (update.currentFile !== undefined) lastCurrentFile = update.currentFile;
        if (update.currentFileSize !== undefined) lastCurrentFileSize = update.currentFileSize;
        lastProgress = Math.max(lastProgress, Math.min(99, Math.max(0, progress)));
        markImportInProgress(phase, sourceName, {
            sourceSize,
            assetDone: restoredAssetFiles.size,
            assetTotal: totalAssetFiles || undefined,
            ...update,
        });
        deps.setSysOperation({
            status: 'processing',
            message: buildImportMessage(headline, update),
            progress: lastProgress,
        });
    };

    const countZipAssetFiles = (zip: JSZipLike) => {
        const files = Object.values((zip as any).files || {}) as any[];
        return files.filter(file => file && !file.dir && typeof file.name === 'string' && file.name.startsWith('assets/')).length;
    };

    const estimateBase64Bytes = (base64: string) => {
        const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
        return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
    };

    showImportProgress('parsing', '正在解析备份文件...', 1, { current: '解析备份文件', sourceSize });
    try {
        let data: FullBackupData;
        let zip: JSZipLike | null = null;

        if (typeof fileOrJson === 'string') {
            data = JSON.parse(fileOrJson);
        } else {
            if (!fileOrJson.name.endsWith('.zip')) {
                try {
                    const text = await fileOrJson.text();
                    data = JSON.parse(text);
                } catch (e) {
                    throw new Error("无效的文件格式，请上传 .zip 或 .json");
                }
            } else {
                const JSZip = await loadJSZip();
                const loadedZip = await JSZip.loadAsync(fileOrJson);
                zip = loadedZip;
                totalAssetFiles = countZipAssetFiles(loadedZip);
                const manifestFile = loadedZip.file("manifest.json");
                if (manifestFile) {
                    // v2：manifest 驱动的分片备份。assembleV2Backup 只读 zip、组装内存对象，
                    // 校验不过直接抛错——此时 importFullData 还没调，DB 一字未动。
                    let manifest: BackupManifest;
                    try {
                        manifest = JSON.parse(await manifestFile.async("string"));
                    } catch {
                        throw new Error("损坏的备份包：manifest.json 解析失败");
                    }
                    data = await assembleV2Backup(
                        loadedZip as unknown as ZipFileReader,
                        manifest,
                        {
                            onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                            onShardProgress: (field, idx, total) => {
                                showImportProgress('parsing', '正在解析备份分片...',
                                    5 + Math.floor((idx / Math.max(1, total)) * 25),
                                    { current: `分片 ${field}` });
                            },
                        },
                    ) as FullBackupData;
                } else {
                    // v1（老备份）：单根 data.json，原样保留，老备份永远打得开。
                    const dataFile = loadedZip.file("data.json");
                    if (!dataFile) throw new Error("损坏的备份包: 缺少 data.json");
                    let jsonStr = await dataFile.async("string");
                    data = JSON.parse(jsonStr);
                    jsonStr = '';
                }
            }
        }

        // 必须发生在 restoreAssetsInPlace / DB.importFullData 之前：不受支持的第三方
        // 备份一旦命中特征就整包拒绝，不能出现“导入了一半才报错”的状态。
        assertSupportedSullyBackup(data);

        // 协同文件先完整读出并校验，再开始写任何主数据库。这样文件索引损坏或 ZIP
        // 缺项时会整包中止，不会出现主数据已恢复、协同文件只回来一半的状态。
        let collaborationAssetRecords: Array<{ id: string; blob: Blob; createdAt: number }> | undefined;
        if (data.collaborationAssetIndex !== undefined) {
            collaborationAssetRecords = [];
            if (data.collaborationAssetIndex.length > 0 && !zip) {
                throw new Error('损坏的备份包：协同文件缺少 ZIP 数据');
            }
            for (let index = 0; index < data.collaborationAssetIndex.length; index++) {
                const item = data.collaborationAssetIndex[index];
                if (!item?.id || !item.path?.startsWith('collaboration/assets/')) {
                    throw new Error('损坏的备份包：协同文件索引无效');
                }
                const entry = zip?.file(item.path);
                if (!entry) throw new Error(`损坏的备份包：缺少协同文件 ${item.path}`);
                const bytes = await entry.async('uint8array');
                if (typeof item.size === 'number' && item.size >= 0 && bytes.byteLength !== item.size) {
                    throw new Error(`损坏的备份包：协同文件大小不符 ${item.path}`);
                }
                const fileBytes = new Uint8Array(bytes.byteLength);
                fileBytes.set(bytes);
                collaborationAssetRecords.push({
                    id: item.id,
                    blob: new Blob([fileBytes.buffer], { type: item.mimeType || 'application/octet-stream' }),
                    createdAt: Number(item.createdAt) || Date.now(),
                });
                if (index % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        }

        // v2 backups keep favorite voice bytes outside JSON. Rehydrate every marker
        // before DB.importFullData starts, so a missing/truncated file aborts while
        // the current database is still untouched.
        if (zip && Array.isArray(data.assets)) {
            await restoreVoiceMessageBlobs(data.assets, async path => {
                const entry = zip?.file(path);
                return entry ? entry.async('uint8array') : null;
            });
        }

        // v3 blob 旁路：令牌原样在 JSON 里，二进制在 blobs/*。readBlobsIndex 先把索引
        // 与文件齐全性验完（此时一个字节没写），再按原令牌 id 写回 blob_assets——令牌
        // 身份保住，JSON 引用零改写、零重编码。中途失败直接中止导入：主数据尚未写库，
        // 已写回的部分只是孤儿 blob，由手动 GC 收口。v2 老包没有索引文件，这里是 no-op。
        if (zip) {
            const blobEntries = await readBlobsIndex(zip as unknown as ZipFileReader);
            if (blobEntries.length > 0) {
                await restoreBlobsFromZip(
                    zip as unknown as ZipFileReader,
                    blobEntries,
                    restoreBlobRef,
                    {
                        onYield: () => new Promise<void>(r => setTimeout(r, 0)),
                        onProgress: (done, total, id) => {
                            showImportProgress('assets', '正在恢复图片二进制...',
                                30 + Math.floor((done / Math.max(1, total)) * 5),
                                { current: `图片二进制 ${done}/${total}`, currentFile: id });
                        },
                    },
                );
            }
        }

        const hadAssetStoreBackup = data.assets !== undefined;
        const hadCustomIconsBackup = data.customIcons !== undefined;
        const hadAppearancePresetsBackup = data.appearancePresets !== undefined;

        const restoreAssetsInPlace = async (root: any, label = '数据'): Promise<void> => {
            if (!zip) return;

            type Ref = { parent: any; key: string | number; filename: string };
            const refsByFile = new Map<string, Ref[]>();
            const seen = new WeakSet<object>();
            const stack: any[] = [root];
            while (stack.length) {
                const node = stack.pop();
                if (node === null || typeof node !== 'object') continue;
                if (seen.has(node)) continue;
                seen.add(node);
                if (Array.isArray(node)) {
                    for (let i = 0; i < node.length; i++) {
                        const v = node[i];
                        if (typeof v === 'string' && v.startsWith('assets/')) {
                            const filename = v.slice('assets/'.length);
                            const refs = refsByFile.get(filename) || [];
                            refs.push({ parent: node, key: i, filename });
                            refsByFile.set(filename, refs);
                        } else if (v && typeof v === 'object') {
                            stack.push(v);
                        }
                    }
                } else {
                    for (const k in node) {
                        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                        const v = node[k];
                        if (typeof v === 'string' && v.startsWith('assets/')) {
                            const filename = v.slice('assets/'.length);
                            const refs = refsByFile.get(filename) || [];
                            refs.push({ parent: node, key: k, filename });
                            refsByFile.set(filename, refs);
                        } else if (v && typeof v === 'object') {
                            stack.push(v);
                        }
                    }
                }
            }

            const entries = Array.from(refsByFile.entries());
            if (entries.length === 0) return;

            for (const [filename, refs] of entries) {
                const fileInZip = zip.file(`assets/${filename}`) as (JSZipFileLike & { _data?: { compressedSize?: number; uncompressedSize?: number } }) | null;
                const hintedSize = fileInZip?._data?.uncompressedSize || fileInZip?._data?.compressedSize;
                showImportProgress('assets', '正在恢复素材...', 35 + Math.floor((restoredAssetFiles.size / Math.max(1, totalAssetFiles || entries.length)) * 35), {
                    current: label,
                    currentFile: filename,
                    currentFileSize: hintedSize,
                    assetDone: restoredAssetFiles.size,
                    assetTotal: totalAssetFiles || entries.length,
                });

                try {
                    if (!fileInZip) {
                        console.warn(`Missing asset in backup: assets/${filename}`);
                        continue;
                    }
                    const base64 = await fileInZip.async("base64");
                    const ext = (filename.split('.').pop() || 'png').toLowerCase();
                    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                        : ext === 'gif' ? 'image/gif'
                        : ext === 'webp' ? 'image/webp'
                        : 'image/png';
                    const dataUri = `data:${mime};base64,${base64}`;
                    for (const ref of refs) {
                        ref.parent[ref.key] = dataUri;
                    }
                    const decodedSize = estimateBase64Bytes(base64);
                    restoredAssetFiles.add(filename);
                    showImportProgress('assets', '正在恢复素材...', 35 + Math.floor((restoredAssetFiles.size / Math.max(1, totalAssetFiles || entries.length)) * 35), {
                        current: label,
                        currentFile: filename,
                        currentFileSize: decodedSize,
                        assetDone: restoredAssetFiles.size,
                        assetTotal: totalAssetFiles || entries.length,
                    });
                } catch {
                    console.warn(`Failed to restore asset: assets/${filename}`);
                }
                await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
        };

        showImportProgress('database', '正在写入数据库...', 50, { current: '准备写入数据库', currentFile: '' });
        await DB.importFullData(data, {
            beforeWrite: restoreAssetsInPlace,
            onProgress: progress => {
                const sectionRatio = progress.sectionTotal > 0
                    ? progress.sectionDone / progress.sectionTotal
                    : 0;
                const itemRatio = progress.itemTotal && progress.sectionTotal > 0
                    ? ((progress.itemDone || 0) / progress.itemTotal) / progress.sectionTotal
                    : 0;
                const dbProgress = 50 + Math.floor(Math.min(1, sectionRatio + itemRatio) * 40);
                showImportProgress('database', '正在写入数据库...', dbProgress, {
                    current: progress.stage === 'done' ? `${progress.label}完成` : progress.label,
                    currentFile: '',
                    itemDone: progress.itemDone,
                    itemTotal: progress.itemTotal,
                });
            },
        });

        const hasCollaborationBackup = data.collaborationSessions !== undefined
            || data.collaborationMessages !== undefined
            || data.collaborationCategories !== undefined
            || data.collaborationSettings !== undefined
            || collaborationAssetRecords !== undefined;
        if (hasCollaborationBackup) {
            showImportProgress('database', '正在恢复协同工作...', 91, { current: '协同窗口与文件', currentFile: '' });
            const { CollaborationStore } = await import('../features/collaboration/store');
            await CollaborationStore.importBackup({
                sessions: data.collaborationSessions,
                messages: data.collaborationMessages,
                categories: data.collaborationCategories,
                settings: data.collaborationSettings,
                assets: collaborationAssetRecords,
            }, {
                replaceAssets: data.collaborationBackupMode === 'full',
            });
        }
        
        showImportProgress('settings', '正在恢复系统设置...', 92, { current: '系统设置', currentFile: '' });
        if (data.theme) {
            await restoreAssetsInPlace(data.theme, '系统主题');
            await deps.updateTheme(data.theme);
        }
        if (data.apiConfig) {
            // GitHub 自动备份等管道导出的包是**脱敏**的（apiKey 置空）。导入这种包时绝不能
            // 拿空 key 覆盖本机已填好的真实凭据——实测自动恢复「清空设备→拉回备份」后
            // 表单 key 被抹空。updateApiConfig 是 merge 语义，这里干脆不传 apiKey 这个键：
            // 备份带了非空 key 才覆盖，脱敏空值保留本机现值。
            const { apiKey: incomingKey, ...restConfig } = data.apiConfig;
            deps.updateApiConfig(incomingKey?.trim() ? data.apiConfig : restConfig);
        }
        if (data.checkPhoneApi !== undefined) setCheckPhoneApi(data.checkPhoneApi ?? null);
        if (data.availableModels) deps.saveModels(data.availableModels);
        if (data.apiPresets) {
            // 预设的 key 同样被脱敏导出成空串，而 savePresets 是整组替换——不合并的话
            // 导入一次就把「key 只填在预设里」的本机凭据全部抹空。同 id 对齐：备份里
            // 非空的照常恢复，空 key 的预设保留本机已填的那把。
            const localKeyById = new Map(
                (deps.apiPresets || [])
                    .filter(p => (p?.config?.apiKey || '').trim())
                    .map(p => [p.id, p.config.apiKey] as const),
            );
            const mergedPresets = data.apiPresets.map((p: ApiPreset) => {
                if ((p?.config?.apiKey || '').trim()) return p;
                const localKey = localKeyById.get(p?.id);
                return localKey ? { ...p, config: { ...p.config, apiKey: localKey } } : p;
            });
            deps.savePresets(mergedPresets);
        }
        if (data.realtimeConfig) {
            // 同 apiConfig：脱敏导出把 weatherApiKey / newsApiKey / notionApiKey 等
            // 置空，导入时逐键保留本机已填的值，只恢复非密钥的配置项（开关/城市/平台表）。
            const mergedRealtime: Record<string, unknown> = { ...data.realtimeConfig };
            const localRealtime = (deps.realtimeConfig ?? {}) as unknown as Record<string, unknown>;
            for (const k of Object.keys(mergedRealtime)) {
                if (!/api[-_]?key|token|secret|authorization|auth[-_]?header/i.test(k)) continue;
                const incoming = mergedRealtime[k];
                if (typeof incoming !== 'string' || incoming.trim()) continue; // 带真实值才覆盖
                const localVal = localRealtime[k];
                if (typeof localVal === 'string' && localVal.trim()) mergedRealtime[k] = localVal;
            }
            deps.updateRealtimeConfig(mergedRealtime as unknown as RealtimeConfig); // 恢复实时感知配置
        }
        if (data.memoryPalaceConfig) deps.updateMemoryPalaceConfig(data.memoryPalaceConfig); // 恢复记忆宫殿全局配置

        if (data.customIcons !== undefined || data.appearancePresets !== undefined) {
            await restoreAssetsInPlace(data.customIcons, '应用图标');
            await restoreAssetsInPlace(data.appearancePresets, '外观预设');
            const existingAssets = await DB.getAllAssets();
            if (Array.isArray(existingAssets)) {
                for (const asset of existingAssets) {
                    if (data.customIcons !== undefined && asset.id.startsWith('icon_')) {
                        await DB.deleteAsset(asset.id);
                    }
                    if (data.appearancePresets !== undefined && asset.id.startsWith('appearance_preset_')) {
                        await DB.deleteAsset(asset.id);
                    }
                }
            }
            if (data.customIcons) {
                for (const [appId, iconUrl] of Object.entries(data.customIcons)) {
                    const stored = iconUrl.startsWith('data:') ? await migrateDataUrlToRef(iconUrl) : iconUrl;
                    await DB.saveAsset(`icon_${appId}`, stored);
                }
            }
            if (data.appearancePresets) {
                const migratedPresets: AppearancePreset[] = [];
                for (const preset of data.appearancePresets) {
                    const migrated = await migrateAppearancePresetBlobRefs(preset);
                    migratedPresets.push(migrated);
                    await DB.saveAsset(`appearance_preset_${migrated.id}`, JSON.stringify(migrated));
                }
                data.appearancePresets = migratedPresets;
            }
        }

        // Restore Study Room settings
        if (data.studyApiConfig) localStorage.setItem('study_api_config', JSON.stringify(data.studyApiConfig));
        if (data.studyTutorPresets) localStorage.setItem('study_tutor_presets', JSON.stringify(data.studyTutorPresets));

        // Restore 云端配置
        if (data.cloudBackupConfig) localStorage.setItem('os_cloud_backup_config', JSON.stringify(data.cloudBackupConfig));
        if (data.remoteVectorConfig) localStorage.setItem('os_remote_vector_config', JSON.stringify(data.remoteVectorConfig));

        // Restore Instant Push
        if (data.instantPushConfig) localStorage.setItem('instant_push_config_v1', JSON.stringify(data.instantPushConfig));
        if (data.pushVapid) localStorage.setItem('push_vapid_v1', JSON.stringify(data.pushVapid));


        // Restore Memory Palace 水位线
        if (data.memoryPalaceHighWaterMarks) {
            for (const [charId, hwm] of Object.entries(data.memoryPalaceHighWaterMarks)) {
                if (typeof hwm === 'number' && hwm > 0) {
                    localStorage.setItem(`mp_lastMsgId_${charId}`, String(hwm));
                }
            }
        }

        // Restore Memory Palace UI flags（人格检测已跑过 / 首次 banner 已见等）
        if (data.memoryPalaceFlags && typeof data.memoryPalaceFlags === 'object') {
            for (const [key, val] of Object.entries(data.memoryPalaceFlags)) {
                if (typeof val === 'string') {
                    // 只允许恢复 mp_ 前缀的键，避免导入数据污染其它 localStorage
                    if (key.startsWith('mp_personality_tried_')
                        || key.startsWith('mp_first_archive_notice_')) {
                        localStorage.setItem(key, val);
                    }
                }
            }
        }

        // Restore Chat 翻译 / 归档 / 润色设置
        if (typeof data.chatTranslateSourceLang === 'string') localStorage.setItem('chat_translate_source_lang', data.chatTranslateSourceLang);
        if (typeof data.chatTranslateTargetLang === 'string') localStorage.setItem('chat_translate_lang', data.chatTranslateTargetLang);
        if (data.chatTranslateEnabledByChar && typeof data.chatTranslateEnabledByChar === 'object') {
            for (const [charId, enabled] of Object.entries(data.chatTranslateEnabledByChar)) {
                localStorage.setItem(`chat_translate_enabled_${charId}`, enabled ? 'true' : 'false');
            }
        }
        if (data.chatTranslateExpandedByChar && typeof data.chatTranslateExpandedByChar === 'object') {
            for (const [charId, expanded] of Object.entries(data.chatTranslateExpandedByChar)) {
                localStorage.setItem(`chat_translate_expanded_${charId}`, expanded ? 'true' : 'false');
            }
        }
        if (data.chatTranslateSourceLangByChar && typeof data.chatTranslateSourceLangByChar === 'object') {
            for (const [charId, lang] of Object.entries(data.chatTranslateSourceLangByChar)) {
                if (typeof lang === 'string') localStorage.setItem(`chat_translate_source_lang_${charId}`, lang);
            }
        }
        if (data.chatTranslateTargetLangByChar && typeof data.chatTranslateTargetLangByChar === 'object') {
            for (const [charId, lang] of Object.entries(data.chatTranslateTargetLangByChar)) {
                if (typeof lang === 'string') localStorage.setItem(`chat_translate_lang_${charId}`, lang);
            }
        }
        if (data.chatArchivePrompts !== undefined) localStorage.setItem('chat_archive_prompts', JSON.stringify(data.chatArchivePrompts));
        if (typeof data.chatActiveArchivePromptId === 'string') localStorage.setItem('chat_active_archive_prompt_id', data.chatActiveArchivePromptId);
        if (data.characterRefinePrompts !== undefined) localStorage.setItem('character_refine_prompts', JSON.stringify(data.characterRefinePrompts));
        if (typeof data.characterActiveRefinePromptId === 'string') localStorage.setItem('character_active_refine_prompt_id', data.characterActiveRefinePromptId);

        // Restore UI / 偏好
        if (typeof data.scheduleAppTheme === 'string') localStorage.setItem('schedule_app_theme', data.scheduleAppTheme);
        if (typeof data.handbookLifestreamDepth === 'string') localStorage.setItem('handbook_lifestream_depth', data.handbookLifestreamDepth);
        if (typeof data.groupchatContextLimit === 'number') localStorage.setItem('groupchat_context_limit', String(data.groupchatContextLimit));
        if (data.browserConfig && typeof data.browserConfig === 'object') {
            if (typeof data.browserConfig.braveKey === 'string') localStorage.setItem('browser_brave_key', data.browserConfig.braveKey);
            if (typeof data.browserConfig.useRealSearch === 'boolean') localStorage.setItem('browser_use_real_search', data.browserConfig.useRealSearch ? 'true' : 'false');
        }
        if (typeof data.bm25Mode === 'string') localStorage.setItem('bm25_mode', data.bm25Mode);
        if (typeof data.lastActiveCharId === 'string') localStorage.setItem('os_last_active_char_id', data.lastActiveCharId);
        restoreStoryTheaterAppearanceSetting(data.storyTheaterAppearance);
        if (data.dreamCollection && typeof data.dreamCollection === 'object') localStorage.setItem('os_dream_collection', JSON.stringify(data.dreamCollection));
        if (typeof data.gotchiAccentHue === 'string' && /^\d+$/.test(data.gotchiAccentHue)) localStorage.setItem('tama_accent_hue', data.gotchiAccentHue);
        if (data.eventNotifFlags && typeof data.eventNotifFlags === 'object') {
            for (const [key, val] of Object.entries(data.eventNotifFlags)) {
                // 只允许 sullyos_ 前缀，避免污染其它键
                if (typeof val === 'string' && key.startsWith('sullyos_')) {
                    localStorage.setItem(key, val);
                }
            }
        }
        
        if (data.socialAppData) {
            await restoreAssetsInPlace(data.socialAppData, '动态设置');
            if (data.socialAppData.charHandles) localStorage.setItem('spark_char_handles', JSON.stringify(data.socialAppData.charHandles));
            if (data.socialAppData.userId) localStorage.setItem('spark_user_id', data.socialAppData.userId);
            // 数值型 Spark 设置：只在备份里有值时回写，恢复端不做默认值兜底
            if (typeof data.socialAppData.commentDelayMs === 'number') localStorage.setItem('spark_comment_delay_ms', String(data.socialAppData.commentDelayMs));
            if (typeof data.socialAppData.autoRefreshMinutes === 'number') localStorage.setItem('spark_auto_refresh_minutes', String(data.socialAppData.autoRefreshMinutes));

            // Restore heavy assets to DB
            if (data.socialAppData.userProfile) await DB.saveAsset('spark_social_profile', JSON.stringify(data.socialAppData.userProfile));
            if (data.socialAppData.userBg) await DB.saveAsset('spark_user_bg', data.socialAppData.userBg);
        }
        
        // Restore Room Custom Assets to DB (migrate old format on import)
        if (data.roomCustomAssets) {
            await restoreAssetsInPlace(data.roomCustomAssets, '房间自定义素材');
            const migratedAssets = data.roomCustomAssets.map((a: any) => ({
                ...a,
                id: a.id || `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                visibility: a.visibility || 'public',
            }));
            await DB.saveAsset('room_custom_assets_list', JSON.stringify(migratedAssets));
        }

        const chars = await DB.getAllCharacters();
        const groupsList = await DB.getGroups();
        const themes = await DB.getThemes();
        const user = await DB.getUserProfile();
        const books = await DB.getAllWorldbooks();
        const novelList = await DB.getAllNovels();
        const songList = await DB.getAllSongs();
        
        if (hadAssetStoreBackup || hadCustomIconsBackup || hadAppearancePresetsBackup) {
            const assets = await DB.getAllAssets();
            const loadedIcons: Record<string, string> = {};
            const loadedPresets: AppearancePreset[] = [];
            if (Array.isArray(assets)) {
                for (const a of assets) {
                    if (a.id.startsWith('icon_')) {
                        const stored = a.data.startsWith('data:') ? await migrateDataUrlToRef(a.data) : a.data;
                        loadedIcons[a.id.replace('icon_', '')] = stored;
                        if (stored !== a.data) await DB.saveAsset(a.id, stored);
                    }
                    if (a.id.startsWith('appearance_preset_')) {
                        try {
                            loadedPresets.push(JSON.parse(a.data));
                        } catch {}
                    }
                }
            }
            deps.setCustomIcons(loadedIcons);
            loadedPresets.sort((a, b) => b.createdAt - a.createdAt);
            deps.setAppearancePresets(loadedPresets);
        }

        // 导入后的角色清单（下面主动消息 2.0 对账要用规范化之后的那份）
        let importedChars = chars;
        if (chars.length > 0) {
            let importedAutoContextCount = 0;
            let importedContextMigrated = false;
            const normalizedChars = chars.map(c => {
                const normalized = normalizeCharacterDefaults(normalizeCharacterImpression(c));
                const migration = migrateCharacterContextRange(normalized);
                if (migration.migrated) importedContextMigrated = true;
                if (migration.resetAutoContext) importedAutoContextCount++;
                return migration.character;
            });
            if (importedContextMigrated) {
                await Promise.all(normalizedChars.map(c => DB.saveCharacter(c)));
            }
            deps.setCharacters(normalizedChars);
            importedChars = normalizedChars;
            if (importedAutoContextCount > 0) {
                setTimeout(() => deps.addToast(
                    `导入的旧设置已升级：${importedAutoContextCount} 个全自动记忆角色已使用自适应上下文。`,
                    'info',
                ), 600);
            }
        }
        if (groupsList.length > 0) deps.setGroups(groupsList);
        if (themes.length > 0) deps.setCustomThemes(themes);
        if (user) deps.setUserProfile(user);
        if (books.length > 0) deps.setWorldbooks(books);
        if (novelList.length > 0) deps.setNovels(novelList);
        if (songList.length > 0) deps.setSongs(songList);

        // ─── 主动消息 2.0：导入后跟云端对一次账 ───
        // 导入换掉了整套角色，worker 那边却还停在导入前：旧档角色的远端任务变成无主任务
        // 到点照样推送，新档角色的 fire_pack 和工具凭据则停格在导入前那一刻。
        // 整段 best-effort：这是恢复流程的收尾，云端够不着不该让已经写好的本地数据回滚。
        try {
            const amsgWorkerUrl = (await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim();
            if (amsgWorkerUrl) {
                const knownCharIds = new Set(importedChars.map(c => c.id));
                const remoteTasks = await ActiveMsgClient.listAllTasks();
                for (const task of remoteTasks) {
                    if (typeof task?.uuid !== 'string') continue;
                    const owner = typeof task?.charId === 'string' ? task.charId : '';
                    if (owner && knownCharIds.has(owner)) continue;
                    // 「导入即放弃旧数据」：这条任务的主人在新档里已经不存在了（连主人是谁
                    // 都没投影出来的同理），它正属于该一起放弃的部分，取消就是对的。
                    await ActiveMsgClient.cancelTask(task.uuid).catch(() => {});
                }
                // 留下来的角色逐个刷云端快照，同时把导入进来的实时感知凭据传上去。
                // 走同一个入口：云端提示词是按凭据裁过的，两者必须同进同退。
                // 有 AI 任务的角色才会真的上传（门在 markAmsgStateDirty 里）。
                syncAmsgToolConfigAndPrompts(
                    data.realtimeConfig || deps.realtimeConfig,
                    // user 在前面已 setUserProfile 过;兜底取 deps.userProfile(可能为 null,协议要求非空时由同步器自身判空跳过)
                    { characters: importedChars, userProfile: user || deps.userProfile || {} as UserProfile, groups: groupsList },
                );
            }
        } catch (e) {
            console.warn('[amsg2] 导入后云端对账失败（本地数据已恢复，不受影响）', e);
        }

        deps.setSysOperation({ status: 'idle', message: '', progress: 100 });
        clearImportInProgress();
        deps.addToast('恢复成功，系统即将重启...', 'success');
        setTimeout(() => window.location.reload(), 1500);

    } catch (e: any) {
        console.error("Import Error:", e);
        deps.setSysOperation({ status: 'idle', message: '', progress: 0 });
        const msg = e instanceof SyntaxError ? 'JSON 格式错误' : (e.message || '未知错误');
        markImportInProgress('error', sourceName, {
            sourceSize,
            current: lastCurrent,
            currentFile: lastCurrentFile,
            currentFileSize: lastCurrentFileSize,
            assetDone: restoredAssetFiles.size,
            assetTotal: totalAssetFiles || undefined,
            error: msg,
        });
        throw new Error(`恢复失败: ${msg}`);
    }
};

export const resetSystemImpl = async (deps: BackupResetDeps): Promise<void> => { try { await DB.deleteDB(); localStorage.clear(); window.location.reload(); } catch (e) { console.error(e); deps.addToast('重置失败，请手动清除浏览器数据', 'error'); } };
