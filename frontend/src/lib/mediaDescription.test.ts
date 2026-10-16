import {expect,it} from "vitest";
import {mediaDescription} from "./mediaDescription";
it("converts provider breaks and paragraphs to plain text newlines",()=>{
 expect(mediaDescription('First<br>Second<BR/>Third<br />Fourth&lt;br /&gt;Fifth</p>Sixth')).toBe("First\nSecond\nThird\nFourth\nFifth\nSixth");
});
it("removes executable markup while decoding text",()=>{
 expect(mediaDescription('First &amp; second<br><br><b>Next</b><script>alert(1)</script><img src=x onerror=alert(1)>')).toBe("First & second\nNext");
 expect(mediaDescription(null)).toBe("");
});
