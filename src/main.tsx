import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Lab } from "./Lab";
import "./styles.css";

const lab = new URLSearchParams(window.location.search).has("lab");
// 技術検証ページは保存済みキューを変更せずに利用できる。
createRoot(document.getElementById("root")!).render(lab ? <Lab /> : <App />);
