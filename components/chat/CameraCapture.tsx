import React, { useRef, useState, useEffect, useCallback } from 'react';
import { X, Check, ArrowsClockwise } from '@phosphor-icons/react';

/**
 * 聊天拍照：getUserMedia 实时取景 → canvas 截帧 → File 交给现有 onImageSelect 管道。
 *
 * 为什么不用 <input capture>：桌面浏览器只把它当文件选择器；手机 WebView 也常常
 * 直接跳系统相册。实时取景 + 快门才是「拍照」的完整体验，且前后摄可切换。
 * 不支持摄像头（无权限/无设备/非安全上下文）时给出可读的中文错误与关闭出口。
 */

interface CameraCaptureProps {
    onClose: () => void;
    onCapture: (file: File) => void;
}

const CameraCapture: React.FC<CameraCaptureProps> = ({ onClose, onCapture }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [facing, setFacing] = useState<'environment' | 'user'>('environment');
    const [error, setError] = useState('');
    const [preview, setPreview] = useState<string | null>(null);

    const stopStream = useCallback(() => {
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }, []);

    const startStream = useCallback(async (mode: 'environment' | 'user') => {
        stopStream();
        setError('');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false,
            });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play().catch(() => { /* autoplay 被拒绝时靠 muted+playsInline 兜底 */ });
            }
        } catch (e: any) {
            const name = e?.name || '';
            const message = name === 'NotAllowedError'
                ? '摄像头权限被拒绝，请在浏览器站点设置里允许后重试'
                : name === 'NotFoundError' || name === 'OverconstrainedError'
                    ? '没有找到可用的摄像头设备'
                    : e?.message || '无法访问摄像头（页面需要 https 或本地环境）';
            setError(message);
        }
    }, [stopStream]);

    useEffect(() => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setError('当前浏览器不支持摄像头调用');
            return;
        }
        void startStream(facing);
        return () => stopStream();
    }, [facing, startStream, stopStream]);

    const shoot = () => {
        const video = videoRef.current;
        if (!video || !video.videoWidth) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0);
        setPreview(canvas.toDataURL('image/jpeg', 0.92));
    };

    const confirm = () => {
        if (!preview) return;
        const [meta, b64] = preview.split(',');
        const mime = /:(.*?);/.exec(meta)?.[1] || 'image/jpeg';
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        stopStream();
        onCapture(new File([bytes], `camera-${Date.now()}.jpg`, { type: mime }));
    };

    return (
        <div className="fixed inset-0 z-[9999] bg-black flex flex-col select-none">
            {/* 取景区 */}
            <div className="flex-1 relative overflow-hidden">
                {preview ? (
                    <img src={preview} alt="拍照预览" className="w-full h-full object-contain" />
                ) : error ? (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-10 text-center">
                        <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center text-white/60">
                            <X className="w-7 h-7" weight="bold" />
                        </div>
                        <p className="text-xs text-white/60 leading-relaxed">{error}</p>
                    </div>
                ) : (
                    <video
                        ref={videoRef}
                        playsInline
                        muted
                        autoPlay
                        className="w-full h-full object-cover"
                    />
                )}
            </div>

            {/* 顶部关闭 */}
            <button
                onClick={() => { stopStream(); onClose(); }}
                aria-label="关闭拍照"
                className="absolute top-4 left-4 w-10 h-10 rounded-full bg-black/40 backdrop-blur-sm text-white flex items-center justify-center active:scale-95 transition-transform"
            >
                <X className="w-5 h-5" weight="bold" />
            </button>

            {/* 底部操作条 */}
            <div className="bg-black/80 backdrop-blur-md pt-5 pb-8 px-8 flex items-center justify-around">
                {preview ? (
                    <>
                        <button
                            onClick={() => setPreview(null)}
                            className="w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center active:scale-95 transition-transform"
                            aria-label="重拍"
                        >
                            <ArrowsClockwise className="w-5 h-5" weight="bold" />
                        </button>
                        <button
                            onClick={confirm}
                            className="w-16 h-16 rounded-full bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/40 active:scale-95 transition-transform"
                            aria-label="使用照片"
                        >
                            <Check className="w-7 h-7" weight="bold" />
                        </button>
                        <div className="w-12" /> {/* 占位保持对称 */}
                    </>
                ) : (
                    <>
                        <div className="w-12" /> {/* 占位保持对称 */}
                        <button
                            onClick={shoot}
                            disabled={!!error}
                            aria-label="拍照"
                            className={`w-16 h-16 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform ${error ? 'opacity-30' : ''}`}
                        >
                            <div className="w-12 h-12 rounded-full bg-white" />
                        </button>
                        <button
                            onClick={() => setFacing(prev => prev === 'environment' ? 'user' : 'environment')}
                            aria-label="切换前后摄像头"
                            className="w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center active:scale-95 transition-transform"
                        >
                            <ArrowsClockwise className="w-5 h-5" weight="bold" />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default CameraCapture;
