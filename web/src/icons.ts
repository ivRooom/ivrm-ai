/** Small reviewed icon vocabulary: one grid and stroke weight, no remote assets. */
export function icon(
  name:
    | "plus"
    | "menu"
    | "send"
    | "stop"
    | "spark"
    | "panel"
    | "search"
    | "compose"
    | "layers"
    | "folder"
    | "more"
    | "archive"
    | "settings"
    | "copy"
    | "check"
    | "lock"
    | "model"
    | "chevron"
    | "write"
    | "code"
    | "refresh"
    | "branch"
    | "arrow"
): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "20",
    height: "20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    {
      plus: "M12 5v14M5 12h14",
      menu: "M4 6h16M4 12h16M4 18h16",
      send: "M12 19V5m-6 6 6-6 6 6",
      stop: "M6 6h12v12H6z",
      spark: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z",
      panel: "M4 4h16v16H4zM9 4v16",
      search: "M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
      compose: "M13 5H5v14h14v-8M10 14l1-4 7-7 3 3-7 7-4 1z",
      layers: "M3 7l9-4 9 4-9 4-9-4zM3 12l9 4 9-4M3 17l9 4 9-4",
      folder: "M3 6h7l2 3h9v11H3V6z",
      more: "M5 12h.01M12 12h.01M19 12h.01",
      archive: "M3 4h18v4H3zM5 8v12h14V8M9 12h6",
      settings:
        "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
      copy: "M9 9h12v12H9zM15 5V3H3v12h2",
      check: "M5 12l4 4L19 6",
      lock: "M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3",
      model: "M12 3l8 5v8l-8 5-8-5V8l8-5zM4 8l8 5 8-5M12 13v8",
      chevron: "M7 10l5 5 5-5",
      write: "M5 5h14M5 10h14M5 15h9M5 20h6",
      code: "m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18",
      refresh:
        "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1",
      branch: "M6 3v12a4 4 0 0 0 4 4h8M6 7h6a5 5 0 0 0 5-5M15 16l3 3-3 3",
      arrow: "M5 12h14m-5-5 5 5-5 5",
    }[name]
  );
  svg.append(path);
  return svg;
}
