import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Lab } from "./Lab";
import { LayoutLab } from "./LayoutLab";
import "./styles.css";

const parameters = new URLSearchParams(window.location.search);
const lab = parameters.has("lab");
// 技術検証ページは保存済みキューを変更せずに利用できる。
createRoot(document.getElementById("root")!).render(parameters.get("lab") === "layout" ? <LayoutLab /> : lab ? <Lab /> : <App />);
