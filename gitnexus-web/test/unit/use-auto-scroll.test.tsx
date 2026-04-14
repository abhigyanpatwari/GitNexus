import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoScroll } from '../../src/hooks/useAutoScroll';

interface HarnessProps {
  messages: unknown[];
  isChatLoading: boolean;
}

function AutoScrollHarness({ messages, isChatLoading }: HarnessProps) {
  const { scrollContainerRef, messagesContainerRef, isAtBottom, scrollToBottom } = useAutoScroll(
    messages,
    isChatLoading,
  );

  return (
    <>
      <div data-testid="is-at-bottom">{String(isAtBottom)}</div>
      <div data-testid="container" ref={scrollContainerRef}>
        {messages.length > 0 ? (
          <div data-testid="messages-container" ref={messagesContainerRef}>
            {messages.map((message, index) => (
              <div key={index}>{String(message)}</div>
            ))}
          </div>
        ) : null}
      </div>
      <button type="button" onClick={() => scrollToBottom()}>
        Scroll to bottom
      </button>
    </>
  );
}

function setScrollMetrics(
  element: HTMLDivElement,
  metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number },
) {
  if (metrics.scrollTop !== undefined) {
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      writable: true,
      value: metrics.scrollTop,
    });
  }

  if (metrics.scrollHeight !== undefined) {
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      value: metrics.scrollHeight,
    });
  }

  if (metrics.clientHeight !== undefined) {
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      value: metrics.clientHeight,
    });
  }
}

async function flushAnimationFrame() {
  await act(async () => {
    vi.runAllTimers();
  });
}

async function scrollContainer(element: HTMLDivElement, scrollTop: number) {
  setScrollMetrics(element, { scrollTop });
  fireEvent.scroll(element);
  await flushAnimationFrame();
}

const resizeObserverInstances: ResizeObserverMock[] = [];

class ResizeObserverMock {
  callback: ResizeObserverCallback;
  observedElements: Element[] = [];
  observe = vi.fn((element: Element) => {
    this.observedElements.push(element);
  });
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverInstances.push(this);
  }
}

async function triggerResize(instance: ResizeObserverMock) {
  await act(async () => {
    instance.callback([], instance as unknown as ResizeObserver);
  });
  await flushAnimationFrame();
}

describe('useAutoScroll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeObserverInstances.length = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        return window.setTimeout(() => callback(performance.now()), 0);
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => {
        clearTimeout(frameId);
      }),
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function (options: ScrollToOptions) {
        if (options.top !== undefined) {
          Object.defineProperty(this, 'scrollTop', {
            configurable: true,
            writable: true,
            value: options.top,
          });
        }
      },
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts with isAtBottom true and auto-scrolls the very first message', () => {
    const { rerender } = render(<AutoScrollHarness messages={[]} isChatLoading={false} />);

    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('true');

    const container = screen.getByTestId('container') as HTMLDivElement;
    setScrollMetrics(container, { scrollTop: 0, scrollHeight: 500, clientHeight: 200 });

    rerender(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);

    expect(container.scrollTop).toBe(500);
    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('true');
  });

  it('follows streaming updates while the view stays pinned to the bottom', () => {
    const { rerender } = render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;

    setScrollMetrics(container, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });

    rerender(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={true} />);

    expect(container.scrollTop).toBe(1000);
    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('true');
  });

  it('stops auto-scroll after the user scrolls up', async () => {
    const { rerender } = render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;

    setScrollMetrics(container, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });
    await scrollContainer(container, 700);
    await scrollContainer(container, 250);

    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('false');

    setScrollMetrics(container, { scrollTop: 250, scrollHeight: 1400, clientHeight: 200 });
    rerender(<AutoScrollHarness messages={[{ id: 1 }, { id: 2 }]} isChatLoading={true} />);

    expect(container.scrollTop).toBe(250);
  });

  it('re-enables auto-scroll once the user returns near the bottom', async () => {
    const { rerender } = render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;

    setScrollMetrics(container, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });
    await scrollContainer(container, 700);
    await scrollContainer(container, 250);

    setScrollMetrics(container, { scrollTop: 1120, scrollHeight: 1400, clientHeight: 200 });
    await scrollContainer(container, 1120);

    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('true');

    setScrollMetrics(container, { scrollTop: 1120, scrollHeight: 1800, clientHeight: 200 });
    rerender(<AutoScrollHarness messages={[{ id: 1 }, { id: 2 }]} isChatLoading={true} />);

    expect(container.scrollTop).toBe(1800);
  });

  it('scrollToBottom re-engages auto-scroll and scrolls to the container bottom', async () => {
    const { rerender } = render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;
    const scrollTo = vi.spyOn(container, 'scrollTo');

    setScrollMetrics(container, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });
    await scrollContainer(container, 700);
    await scrollContainer(container, 250);

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('false');

    setScrollMetrics(container, { scrollTop: 250, scrollHeight: 1600, clientHeight: 200 });
    rerender(<AutoScrollHarness messages={[{ id: 1 }, { id: 2 }]} isChatLoading={true} />);

    expect(container.scrollTop).toBe(1600);
    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('true');
  });

  it('re-pins to the latest bottom when inner content grows asynchronously', async () => {
    render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;

    setScrollMetrics(container, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });
    await scrollContainer(container, 700);

    setScrollMetrics(container, { scrollTop: 1000, scrollHeight: 1450, clientHeight: 200 });
    await triggerResize(resizeObserverInstances[0]);

    expect(container.scrollTop).toBe(1450);
    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('true');
  });

  it('does not auto-scroll on async growth after user intentionally scrolls away', async () => {
    render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;

    setScrollMetrics(container, { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 });
    await scrollContainer(container, 700);
    await scrollContainer(container, 250);

    setScrollMetrics(container, { scrollTop: 250, scrollHeight: 1400, clientHeight: 200 });
    await triggerResize(resizeObserverInstances[0]);

    expect(container.scrollTop).toBe(250);
    expect(screen.getByTestId('is-at-bottom')).toHaveTextContent('false');
  });

  it('cancels the pending ResizeObserver rAF when the component unmounts', () => {
    const cancelRAF = vi.mocked(cancelAnimationFrame);

    const { unmount } = render(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);
    const container = screen.getByTestId('container') as HTMLDivElement;

    setScrollMetrics(container, { scrollTop: 950, scrollHeight: 1000, clientHeight: 200 });

    const callsBefore = cancelRAF.mock.calls.length;

    act(() => {
      resizeObserverInstances[0].callback(
        [],
        resizeObserverInstances[0] as unknown as ResizeObserver,
      );
    });

    unmount();

    expect(cancelRAF.mock.calls.length).toBeGreaterThan(callsBefore);

    expect(() => vi.runAllTimers()).not.toThrow();
  });

  it('attaches the observer when the messages wrapper first appears and disconnects on unmount', () => {
    const { rerender, unmount } = render(<AutoScrollHarness messages={[]} isChatLoading={false} />);

    expect(screen.queryByTestId('messages-container')).toBeNull();
    expect(resizeObserverInstances).toHaveLength(0);

    rerender(<AutoScrollHarness messages={[{ id: 1 }]} isChatLoading={false} />);

    const messagesContainer = screen.getByTestId('messages-container');
    const resizeObserver = resizeObserverInstances[0];

    expect(resizeObserverInstances).toHaveLength(1);
    expect(resizeObserver.observe).toHaveBeenCalledWith(messagesContainer);

    unmount();

    expect(resizeObserver.disconnect).toHaveBeenCalledTimes(1);
  });
});
