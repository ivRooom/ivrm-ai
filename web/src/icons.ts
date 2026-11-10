/** Small reviewed icon vocabulary: one grid and stroke weight, no remote assets. */
export function icon(name: "plus" | "menu" | "send" | "stop"): SVGSVGElement {
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
    }[name]
  );
  svg.append(path);
  return svg;
}
