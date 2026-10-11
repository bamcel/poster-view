// @vitest-environment jsdom
import {render,screen,cleanup} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import EpisodeMediaInfo from "./EpisodeMediaInfo";
afterEach(cleanup);
it("formats probe values and preserves subtitle flags in separate track cards",()=>{
 render(<EpisodeMediaInfo files={[{path:"episode.mkv",extension:"mkv",size:1024,media_info:{streams:[{codec_type:"video",codec_name:"hevc",width:1920,height:1080,avg_frame_rate:"24000/1001",bit_rate:"4000000"},{codec_type:"subtitle",codec_name:"ass",tags:{language:"eng",title:"Dialogue"},disposition:{default:1,forced:0}}]}}]}/>);
 expect(screen.getByText("1920×1080")).toBeTruthy();
 expect(screen.getByText("23.976")).toBeTruthy();
 expect(screen.getByText("4.0 mbps")).toBeTruthy();
 expect(screen.getByText("Dialogue")).toBeTruthy();
 expect(screen.getByText("Yes")).toBeTruthy();
 expect(screen.getAllByRole("article")).toHaveLength(2);
});
