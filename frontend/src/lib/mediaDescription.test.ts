import {expect,it} from "vitest";
import {mediaDescription} from "./mediaDescription";
it("converts provider breaks and paragraphs to plain text newlines",()=>{
 expect(mediaDescription('First<br>Second<BR/>Third<br />Fourth&lt;br /&gt;Fifth</p>Sixth')).toBe("First\nSecond\nThird\nFourth\nFifth\nSixth");
});
it("removes executable markup while decoding text",()=>{
 expect(mediaDescription('First &amp; second<br><br><b>Next</b><script>alert(1)</script><img src=x onerror=alert(1)>')).toBe("First & second\nNext");
 expect(mediaDescription(null)).toBe("");
});

it("hides bracketed notes including nested and encoded brackets",()=>{
 expect(mediaDescription("Story [Test Test Test] continues.\n[Written by MAL Rewrite]")).toBe("Story continues.");
 expect(mediaDescription("One [outer [inner] note] two &#91;credit&#93; three")).toBe("One two three");
 expect(mediaDescription("[Only credits]")).toBe("");
 expect(mediaDescription("An unmatched [opening remains readable")).toBe("An unmatched [opening remains readable");
 expect(mediaDescription("Story (a meaningful aside) continues.")).toBe("Story (a meaningful aside) continues.");
});
