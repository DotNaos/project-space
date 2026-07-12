import { useEffect, useRef } from 'react';
import {
  renderProjectChatAgentAvatar,
  type ProjectChatAgentAvatarCategory
} from '../project-chat-agent-avatar';

export function ProjectChatAgentAvatar({
  category,
  className = '',
  name,
  size = 36
}: {
  category: ProjectChatAgentAvatarCategory;
  className?: string;
  name: string;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const renderSize = Math.max(24, Math.round(size * scale));
    canvas.width = renderSize;
    canvas.height = renderSize;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return;
    const pixels = renderProjectChatAgentAvatar(name, category, renderSize);
    const image = context.createImageData(renderSize, renderSize);
    image.data.set(pixels);
    context.clearRect(0, 0, renderSize, renderSize);
    context.putImageData(image, 0, 0);
  }, [category, name, size]);

  return (
    <canvas
      aria-hidden="true"
      className={`block shrink-0 rounded-full ${className}`.trim()}
      ref={canvasRef}
      style={{ height: size, width: size }}
    />
  );
}
