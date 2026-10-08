export interface ExactMapping {
  sourceStart: number;
  sourceEnd: number;
  generatedStart: number;
  generatedEnd: number;
}

interface SourceRange {
  start: number;
  end: number;
}

function candidateRanges(source: string): SourceRange[] {
  const lines = source.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const ranges: SourceRange[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ''
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0]!, length: fenceMatch[1].length };
      continue;
    }

    const block = /^ {0,3}<(script|style)\b[^>]*>/i.exec(line);
    if (block?.[1]) {
      const start = starts[i]! + line.indexOf('<');
      const contentStart = start + block[0].trimStart().length;
      const closing = new RegExp(`</${block[1]}\\s*>`, 'i').exec(source.slice(contentStart));
      if (closing) {
        const end = contentStart + closing.index + closing[0].length;
        ranges.push({ start, end });
        while (i + 1 < lines.length && starts[i + 1]! < end) i++;
      }
      continue;
    }

    // Keep this narrow: only a raw tag at the start of a non-fenced line.
    const tag = /^ {0,3}(<\/?[A-Za-z][\w:.-]*(?=[\s/>]))/.exec(line);
    if (tag?.[1]) {
      const start = starts[i]! + line.indexOf('<');
      ranges.push({ start, end: starts[i]! + line.length });
      continue;
    }

    const directive = /^ {0,3}(\{(?:[#:/@][^}]*|[A-Za-z_$][^}]*)\})\s*$/.exec(line);
    if (directive?.[1]) {
      const start = starts[i]! + line.indexOf('{');
      ranges.push({ start, end: start + directive[1].length });
    }
  }

  return ranges;
}

export function createExactMappings(source: string, generated: string): ExactMapping[] {
  const mappings: ExactMapping[] = [];

  for (const range of candidateRanges(source)) {
    const fragment = source.slice(range.start, range.end);
    const generatedStart = generated.indexOf(fragment);
    if (
      generatedStart < 0 ||
      generated.indexOf(fragment, generatedStart + 1) >= 0
    ) {
      continue;
    }

    const generatedEnd = generatedStart + fragment.length;
    if (
      mappings.some(
        (mapping) =>
          generatedStart < mapping.generatedEnd && generatedEnd > mapping.generatedStart
      )
    ) {
      continue;
    }

    mappings.push({
      sourceStart: range.start,
      sourceEnd: range.end,
      generatedStart,
      generatedEnd
    });
  }

  return mappings.sort((a, b) => a.generatedStart - b.generatedStart);
}

export function mapGeneratedRange(
  mappings: ExactMapping[],
  start: number,
  end: number
): SourceRange | null {
  if (start < 0 || end < start) return null;

  const mapping = mappings.find(
    (candidate) => candidate.generatedStart <= start && end <= candidate.generatedEnd
  );
  if (!mapping) return null;

  return {
    start: mapping.sourceStart + start - mapping.generatedStart,
    end: mapping.sourceStart + end - mapping.generatedStart
  };
}
