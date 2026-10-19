import { searchMatchRanges } from '../../../shared/search/query';

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const ranges = searchMatchRanges(text, query);
  let end = 0;
  const parts = ranges.map((range) => {
    const before = text.slice(end, range.start);
    end = range.end;
    return (
      <span key={range.start}>
        {before}
        <mark className="rounded-sm bg-warning text-warning-foreground">
          {text.slice(range.start, range.end)}
        </mark>
      </span>
    );
  });
  return (
    <>
      {parts}
      {text.slice(end)}
    </>
  );
}
