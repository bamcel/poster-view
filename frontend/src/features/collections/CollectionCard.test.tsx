import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {MemoryRouter} from "react-router-dom";
import {afterEach,expect,it} from "vitest";
import CollectionCard from "./CollectionCard";
import type {Collection} from "./client";
const collection:Collection={id:"saga",title:"Saga",overview:"",ordering:"release",revision:1,created_at:"",updated_at:"",members:[],metadata:{provider:"tmdb",provider_id:"42",poster_url:"/poster.jpg",backdrop_url:"/backdrop.jpg",locks:[]}};
afterEach(cleanup);
it("uses provider portrait artwork and falls back to its collection mosaic on image failure",()=>{
 const {container}=render(<MemoryRouter><CollectionCard collection={collection}/></MemoryRouter>);const image=container.querySelector("img")!;expect(image.getAttribute("src")).toBe("/poster.jpg");fireEvent.error(image);expect(container.querySelector("img")).toBeNull();expect(screen.getByRole("link").getAttribute("href")).toBe("/collections/saga");
});
it("uses provider backdrop artwork for landscape collection cards",()=>{
 const {container}=render(<MemoryRouter><CollectionCard collection={collection} backdropView/></MemoryRouter>);expect(container.querySelector("img")?.getAttribute("src")).toBe("/backdrop.jpg");
});
