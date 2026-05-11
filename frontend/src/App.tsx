import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "./pages/Dashboard.tsx";
import EventLog from "./pages/EventLog.tsx";
import RepoDetail from "./pages/RepoDetail.tsx";
import TaskDetail from "./pages/TaskDetail.tsx";
import TaskList from "./pages/TaskList.tsx";
import WorkerDetail from "./pages/WorkerDetail.tsx";

export default function App() {
  return (
    <div style={{ fontFamily: "monospace", padding: "1rem", maxWidth: "1200px", margin: "0 auto" }}>
      <header style={{ marginBottom: "1rem", borderBottom: "1px solid #ccc", paddingBottom: "0.5rem" }}>
        <strong>Brunel</strong>
        {" · "}
        <NavLink to="/">Dashboard</NavLink>
        {" · "}
        <NavLink to="/tasks">Tasks</NavLink>
        {" · "}
        <NavLink to="/log">Event Log</NavLink>
        {" · "}
        <a href="https://github.com/jasoncrawford/brunel" target="_blank" rel="noreferrer">GitHub</a>
      </header>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/tasks" element={<TaskList />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/log" element={<EventLog />} />
        <Route path="/repos/:owner/:repo" element={<RepoDetail />} />
        <Route path="/workers/:id" element={<WorkerDetail />} />
      </Routes>
    </div>
  );
}
