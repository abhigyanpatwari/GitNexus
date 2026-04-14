import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_BOTTOM_THRESHOLD = 100;
const USER_SCROLL_EPSILON = 5;

export interface UseAutoScrollResult {
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
  isAtBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

function isNearBottom(element: HTMLElement, threshold: number): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function useAutoScroll<T>(
  chatMessages: T[],
  isChatLoading: boolean,
  bottomThreshold = DEFAULT_BOTTOM_THRESHOLD,
): UseAutoScrollResult {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const [isAtBottom, setIsAtBottom] = useState(true);

  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollFrameIdRef = useRef<number | null>(null);

  const syncScrollState = useCallback(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    const currentScrollTop = element.scrollTop;
    const nearBottom = isNearBottom(element, bottomThreshold);

    if (nearBottom) {
      shouldStickToBottomRef.current = true;
    } else if (currentScrollTop < lastScrollTopRef.current - USER_SCROLL_EPSILON) {
      shouldStickToBottomRef.current = false;
    }

    lastScrollTopRef.current = currentScrollTop;
    setIsAtBottom(nearBottom);
  }, [bottomThreshold]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const element = scrollContainerRef.current;
      if (!element) return;

      shouldStickToBottomRef.current = true;

      if (behavior === 'auto') {
        element.scrollTop = element.scrollHeight;
        lastScrollTopRef.current = element.scrollTop;
        setIsAtBottom(isNearBottom(element, bottomThreshold));
        return;
      }

      element.scrollTo({
        top: element.scrollHeight,
        behavior,
      });
    },
    [bottomThreshold],
  );

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    lastScrollTopRef.current = element.scrollTop;

    const handleScroll = () => {
      if (scrollFrameIdRef.current !== null) {
        cancelAnimationFrame(scrollFrameIdRef.current);
      }

      scrollFrameIdRef.current = requestAnimationFrame(() => {
        scrollFrameIdRef.current = null;
        syncScrollState();
      });
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    syncScrollState();

    return () => {
      element.removeEventListener('scroll', handleScroll);

      if (scrollFrameIdRef.current !== null) {
        cancelAnimationFrame(scrollFrameIdRef.current);
        scrollFrameIdRef.current = null;
      }
    };
  }, [syncScrollState]);

  useEffect(() => {
    const content = messagesContainerRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!content || !scrollEl || typeof ResizeObserver === 'undefined') return;

    let resizeFrameId: number | null = null;

    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) {
        if (resizeFrameId !== null) {
          cancelAnimationFrame(resizeFrameId);
        }

        resizeFrameId = requestAnimationFrame(() => {
          resizeFrameId = null;
          scrollToBottom('auto');
        });
      } else {
        syncScrollState();
      }
    });

    observer.observe(content);

    return () => {
      observer.disconnect();

      if (resizeFrameId !== null) {
        cancelAnimationFrame(resizeFrameId);
        resizeFrameId = null;
      }
    };
  }, [chatMessages.length, scrollToBottom, syncScrollState]);

  useLayoutEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    scrollToBottom('auto');
  }, [chatMessages.length, isChatLoading, scrollToBottom]);

  return {
    scrollContainerRef,
    messagesContainerRef,
    isAtBottom,
    scrollToBottom,
  };
}
