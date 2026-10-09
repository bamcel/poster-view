import {render,screen,cleanup} from "@testing-library/react";
import {afterEach,expect,it} from "vitest";
import BookSeriesMetadata from "./BookSeriesMetadata";
afterEach(cleanup);
it("shows native NFO book pills and missing volume count",()=>{
 render(<BookSeriesMetadata count={11} metadata={{year:2020,publisher:"Viz",translatedtitle:"English",volumes:21,edition:"Colored",status:"Finished",country:"JP",sourcematerial:"Original"}}/>);
 for(const label of ["Year","Publisher","Translation","Volumes","Edition","Status","Country","Source"])expect(screen.getByText(label)).toBeTruthy();
 expect(screen.getByText("10 Volumes Missing")).toBeTruthy();
});
it("omits empty fields and a missing count for complete series",()=>{
 render(<BookSeriesMetadata count={2} metadata={{volumes:2,publisher:""}}/>);
 expect(screen.queryByText("Publisher")).toBeNull();expect(screen.queryByText(/Missing/)).toBeNull();
 expect(screen.getByText("Complete")).toBeTruthy();
});
it("does not mark a series complete without a known positive total",()=>{
 for(const volumes of [undefined,"",0,"unknown"]){
  const {unmount}=render(<BookSeriesMetadata count={2} metadata={{volumes}}/>);
  expect(screen.queryByText("Complete")).toBeNull();
  unmount();
 }
});
