const paths={
  archive:["M5 4h14a2 2 0 0 1 2 2v2H3V6a2 2 0 0 1 2-2Z","M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8","M9 12h6"],
  new:["M12 5v14M5 12h14"],history:["M3 11a9 9 0 1 1 2.8 7M3 4v7h7","M12 7v5l3 2"],spark:["m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"],
  settings:["M4 7h16M4 17h16","M8 4v6M16 14v6"],hide:["M6 12h12"],close:["m6 6 12 12M18 6 6 18"],
  role:["M20 21v-2a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v2","M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"],
  activity:["M5 4h14v16H5Z","M9 8h6M9 12h6M9 16h3"],folder:["M3 7V5h6l2 2h10v13H3Z"],send:["M12 19V5m-6 6 6-6 6 6"],stop:["M7 7h10v10H7Z"],
  memory:["M9 4a4 4 0 0 0-6 4v2a4 4 0 0 0 0 7v1a3 3 0 0 0 6 1V4Zm6 0a4 4 0 0 1 6 4v2a4 4 0 0 1 0 7v1a3 3 0 0 1-6 1V4Z","M9 9H6m9 0h3M9 15H6m9 0h3"],
  model:["M6 6h12v12H6Z","M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"],book:["M12 5v16M3 4h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"],
  skill:["M9 3H4v6a3 3 0 1 1 0 6v5h6a3 3 0 1 1 5 0h5v-6a3 3 0 1 0 0-5V3h-6a3 3 0 1 1-5 0Z"],tools:["M14 5a6 6 0 0 0-8 8l-3 3 5 5 3-3a6 6 0 0 0 8-8l-4 4-5-5Z"],shield:["M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z","m8 12 3 3 5-6"],info:["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z","M12 11v6m0-10v.1"],thinking:["M12 3a7 7 0 0 0-4 13v3h8v-3a7 7 0 0 0-4-13Z","M9 22h6M9 10l2 2 4-4"],chevron:["m9 5 7 7-7 7"]
};
export function icon(name){const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.classList.add("ui-icon");for(const [key,value] of Object.entries({viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"1.8","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"}))svg.setAttribute(key,value);for(const d of paths[name]||paths.info){const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d",d);svg.append(path);}return svg;}
export function windowHandles(tauri){
  for(const edge of ["North","South","East","West","NorthEast","NorthWest","SouthEast","SouthWest"]){const handle=document.createElement("div");handle.className="resize-handle edge-"+edge;handle.setAttribute("aria-hidden","true");handle.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();void tauri?.core.invoke("resize_window",{edge});};document.body.append(handle);}
  document.addEventListener("pointerdown",e=>{if(e.button===0 && e.target.closest?.("[data-drag-region]") && !e.target.closest("button,input,select,textarea,a,summary"))void tauri?.core.invoke("drag_window");});
}
