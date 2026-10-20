import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import {
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  useMessageScroller,
} from '../../src/components/ui/message-scroller';

function Controls() {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const [ids, setIds] = useState([1, 2, 3, 4]);
  const [height, setHeight] = useState(180);
  return (
    <>
      <button onClick={() => setHeight((value) => value + 100)}>Stream</button>
      <button onClick={() => setIds((value) => [value[0] - 1, ...value])}>Prepend</button>
      <button onClick={() => scrollToEnd()}>Bottom</button>
      <button onClick={() => scrollToMessage('3', { scrollMargin: 12 })}>Third</button>
      <MessageScrollerViewport data-testid="outer" style={{ height: 300, overflowY: 'auto' }}>
        <MessageScrollerContent style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ids.map((id) => (
            <MessageScrollerItem key={id} messageId={String(id)} style={{ flexShrink: 0 }}>
              <div style={{ height: id === 1 ? height : 180 }}>
                Message {id}
                {id === 3 && <Nested />}
              </div>
            </MessageScrollerItem>
          ))}
        </MessageScrollerContent>
      </MessageScrollerViewport>
    </>
  );
}

function Nested() {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScrollerViewport data-testid="inner" style={{ height: 80, overflowY: 'auto' }}>
        <MessageScrollerContent>
          <MessageScrollerItem messageId="reasoning">
            <div style={{ height: 400 }}>Independent reasoning</div>
          </MessageScrollerItem>
        </MessageScrollerContent>
      </MessageScrollerViewport>
    </MessageScrollerProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <MessageScrollerProvider autoScroll defaultScrollPosition="end">
    <Controls />
  </MessageScrollerProvider>,
);
