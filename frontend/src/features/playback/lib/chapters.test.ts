import {expect,it} from "vitest";
import {currentChapter,nextChapterTarget,normalizeChapters,previousChapterTarget} from "./chapters";

const chapters=[{title:"Middle",start_seconds:90},{title:"Intro",start_seconds:0},{title:"End",start_seconds:180}];
it("normalizes unsorted chapters, invalid bounds, duplicates and blank names",()=>{
  expect(normalizeChapters([...chapters,{title:"Duplicate",start_seconds:90},{title:"",start_seconds:30},
    ...[-1,NaN,Infinity,240,250].map(start_seconds=>({title:"Invalid",start_seconds}))],240))
    .toEqual([{title:"Intro",start_seconds:0},{title:"Chapter 5",start_seconds:30},{title:"Middle",start_seconds:90},{title:"End",start_seconds:180}]);
  expect(normalizeChapters(chapters,Infinity)).toEqual([]);
  expect(normalizeChapters(chapters,0)).toEqual([]);
});
it("finds the current chapter across boundaries without assuming ordered metadata",()=>{
  expect(currentChapter(chapters,0,240)?.title).toBe("Intro");
  expect(currentChapter(chapters,89.9,240)?.title).toBe("Intro");
  expect(currentChapter(chapters,90,240)?.title).toBe("Middle");
  expect(currentChapter([{title:"Later",start_seconds:30}],10,240)).toBeNull();
  expect(currentChapter(chapters,NaN,240)).toBeNull();
});
it("restarts the current chapter after three seconds, otherwise selects the previous chapter",()=>{
  expect(previousChapterTarget(chapters,94,240)).toBe(90);
  expect(previousChapterTarget(chapters,93,240)).toBe(0);
  expect(previousChapterTarget(chapters,90,240)).toBe(0);
  expect(previousChapterTarget(chapters,2,240)).toBeNull();
  expect(previousChapterTarget(chapters,4,240)).toBe(0);
});
it("selects the strictly next chapter and never seeks outside valid metadata",()=>{
  expect(nextChapterTarget(chapters,89,240)).toBe(90);
  expect(nextChapterTarget(chapters,90,240)).toBe(180);
  expect(nextChapterTarget(chapters,180,240)).toBeNull();
  expect(nextChapterTarget(chapters,NaN,240)).toBeNull();
  expect(previousChapterTarget([],5,240)).toBeNull();
});
