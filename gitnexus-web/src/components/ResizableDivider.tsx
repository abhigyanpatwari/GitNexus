import { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';

interface ResizableDividerProps {
  onResize: (delta: number) => void;
  minWidth?: number;
  maxWidth?: number;
  side: 'left' | 'right';
}

export const ResizableDivider = ({ onResize, minWidth = 200, maxWidth = 800, side }: ResizableDividerProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef<number>(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = side === 'left' 
        ? e.clientX - startXRef.current 
        : startXRef.current - e.clientX;
      
      startXRef.current = e.clientX;
      onResize(delta);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Add cursor style to body while dragging
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, onResize, side]);

  return (
    <div
      className={`
        relative flex items-center justify-center
        w-1 bg-border-subtle hover:bg-accent/50 
        cursor-col-resize transition-colors
        ${isDragging ? 'bg-accent' : ''}
        group
      `}
      onMouseDown={handleMouseDown}
    >
      {/* Wider hit area for easier grabbing */}
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
      
      {/* Visual grip indicator */}
      <div className={`
        absolute inset-y-0 flex items-center justify-center
        opacity-0 group-hover:opacity-100 transition-opacity
        ${isDragging ? 'opacity-100' : ''}
      `}>
        <GripVertical className="w-3 h-3 text-accent" />
      </div>
    </div>
  );
};
