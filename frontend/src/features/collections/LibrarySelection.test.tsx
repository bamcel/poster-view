import {act,fireEvent,renderHook} from "@testing-library/react";
import {expect,it} from "vitest";
import {useLibrarySelection} from "./LibrarySelection";

it("keeps selections through filters, supports ranges, and resets for a different library",()=>{
  const {result,rerender}=renderHook(({library,visible})=>useLibrarySelection(library,visible,true),{initialProps:{library:"one",visible:["a","b","c"]}});
  act(()=>result.current.toggle("a"));
  act(()=>result.current.toggle("c",true));
  expect([...result.current.ids]).toEqual(["a","b","c"]);
  rerender({library:"one",visible:["b"]});
  expect(result.current.hidden).toBe(2);
  rerender({library:"two",visible:["b"]});
  expect(result.current.ids.size).toBe(0);
  expect(result.current.active).toBe(false);
});
it("selects visible titles with the keyboard, ignores typing fields, and clears with Escape",()=>{
  const {result,unmount}=renderHook(()=>useLibrarySelection("one",["a","b"],true));
  act(()=>result.current.start());
  const input=document.createElement("input");document.body.append(input);
  fireEvent.keyDown(input,{key:"a",ctrlKey:true});
  expect(result.current.ids.size).toBe(0);
  fireEvent.keyDown(window,{key:"a",ctrlKey:true});
  expect(result.current.ids.size).toBe(2);
  fireEvent.keyDown(window,{key:"Escape"});
  expect(result.current.active).toBe(false);
  expect(result.current.ids.size).toBe(0);
  input.remove();unmount();
});
