import type { HeadingDepth, TocSettings } from "./settings";

export type HeadingInfo = {
  id: string;
  text: string;
  depth: HeadingDepth;
  relativeDepth: HeadingDepth;
  element: HTMLElement;
  answerId: string;
  answerIndex: number;
  order: number;
};

export type AnswerOutline = {
  id: string;
  label: string;
  element: Element;
  headings: HeadingInfo[];
  minDepth: HeadingDepth;
};

const headingSelector = "h1,h2,h3,h4,h5,h6";

const getHeadingDepth = (element: Element): HeadingDepth | null => {
  const depth = Number(element.tagName.slice(1));
  return depth >= 1 && depth <= 6 ? (depth as HeadingDepth) : null;
};

const isJsdom = (element: HTMLElement): boolean =>
  element.ownerDocument.defaultView?.navigator.userAgent.includes("jsdom") ?? false;

const hasLayoutBox = (element: HTMLElement): boolean => {
  if (isJsdom(element)) {
    return true;
  }

  const rects = element.getClientRects();
  if (rects.length === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
};

const isVisibleHeading = (element: HTMLElement): boolean => {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current && current !== element.ownerDocument.body) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") {
      return false;
    }

    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") {
      return false;
    }

    current = current.parentElement;
  }

  return hasLayoutBox(element);
};

const ensureAnswerId = (element: Element, answerIndex: number): string => {
  const htmlElement = element as HTMLElement;
  const id = `gpt-reader-answer-${answerIndex + 1}`;
  htmlElement.dataset.gptReaderAnswerId = id;
  return id;
};

const ensureHeadingId = (
  heading: HTMLElement,
  answerIndex: number,
  headingIndex: number
): string => {
  const id = `gpt-reader-heading-${answerIndex + 1}-${headingIndex + 1}`;
  heading.dataset.gptReaderHeadingId = id;
  heading.style.scrollMarginTop = "96px";
  return id;
};

export const extractAnswerOutlines = (answerElements: Element[]): AnswerOutline[] =>
  answerElements
    .map((answerElement, answerIndex): AnswerOutline | null => {
      const answerId = ensureAnswerId(answerElement, answerIndex);
      const headings = Array.from(answerElement.querySelectorAll<HTMLElement>(headingSelector))
        .map((heading, headingIndex): HeadingInfo | null => {
          const text = heading.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const depth = getHeadingDepth(heading);

          if (!text || !depth || !isVisibleHeading(heading)) {
            return null;
          }

          return {
            id: ensureHeadingId(heading, answerIndex, headingIndex),
            text,
            depth,
            relativeDepth: depth,
            element: heading,
            answerId,
            answerIndex,
            order: headingIndex
          };
        })
        .filter((heading): heading is HeadingInfo => Boolean(heading));

      if (headings.length === 0) {
        return null;
      }

      const minDepth = Math.min(...headings.map((heading) => heading.depth)) as HeadingDepth;
      const headingsWithRelativeDepth = headings.map((heading) => ({
        ...heading,
        relativeDepth: Math.min(6, heading.depth - minDepth + 1) as HeadingDepth
      }));

      return {
        id: answerId,
        label: `回答 ${answerIndex + 1}`,
        element: answerElement,
        headings: headingsWithRelativeDepth,
        minDepth
      };
    })
    .filter((outline): outline is AnswerOutline => Boolean(outline));

export const getVisibleHeadingsForAnswer = (
  outline: AnswerOutline,
  settings: TocSettings,
  currentAnswerId: string | null
): HeadingInfo[] => {
  const isCurrentAnswer = outline.id === currentAnswerId;

  if (!settings.expandCurrentOnly || isCurrentAnswer) {
    return outline.headings.filter((heading) => heading.relativeDepth <= settings.maxDepth);
  }

  return outline.headings.filter((heading) => heading.relativeDepth === 1);
};

export const flattenHeadings = (outlines: AnswerOutline[]): HeadingInfo[] =>
  outlines.flatMap((outline) => outline.headings);
