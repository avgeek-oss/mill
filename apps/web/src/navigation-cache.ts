import type { Board, Task } from "../../../packages/contracts/src/index.js";
import { boardUrl, type BoardUrlState } from "./board-url.js";

export type TaskListPage = {
  items: Task[];
  total: number;
  page: number;
  revision: string;
};
type BoardPage = { board: Board; tasks: TaskListPage };
type Entry<T> = { value: T; expiresAt: number };
const lifetime = 5 * 60_000;

export class NavigationCache {
  generation = 0;
  private pages = new Map<string, Entry<BoardPage>>();
  private tasks = new Map<string, Entry<Task>>();

  constructor(private now = Date.now) {}

  clear() {
    this.generation++;
    this.pages.clear();
    this.tasks.clear();
  }

  private read<T>(entries: Map<string, Entry<T>>, key: string) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  private write<T>(
    entries: Map<string, Entry<T>>,
    key: string,
    value: T,
    limit: number,
  ) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: this.now() + lifetime });
    while (entries.size > limit) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  boardPage(boardId: string, state: BoardUrlState) {
    return this.read(this.pages, boardUrl(boardId, state));
  }

  rememberBoardPage(
    board: Board,
    state: BoardUrlState,
    tasks: TaskListPage,
    generation: number,
  ) {
    if (generation !== this.generation) return;
    const items = tasks.items.map((task) => {
      this.rememberTask(task, generation);
      return this.task(task.id) ?? task;
    });
    this.write(
      this.pages,
      boardUrl(board.id, { ...state, page: tasks.page }),
      { board, tasks: { ...tasks, items } },
      8,
    );
  }

  task(taskId: string) {
    return this.read(this.tasks, taskId);
  }

  rememberBoard(board: Board) {
    for (const entry of this.pages.values()) {
      if (entry.value.board.id !== board.id) continue;
      if (entry.value.board.version > board.version) continue;
      if (entry.value.board.prefix !== board.prefix) {
        this.forgetBoard(board.id);
        return;
      }
      entry.value = { ...entry.value, board };
    }
  }

  rememberTask(task: Task, generation: number) {
    if (generation !== this.generation) return;
    const previous = this.task(task.id);
    if (previous && previous.version > task.version) return;
    this.write(this.tasks, task.id, task, 100);
    for (const entry of this.pages.values()) {
      if (entry.value.board.id !== task.boardId) continue;
      entry.value = {
        ...entry.value,
        tasks: {
          ...entry.value.tasks,
          items: entry.value.tasks.items.map((item) =>
            item.id === task.id && item.version <= task.version ? task : item,
          ),
        },
      };
    }
  }

  forgetTask(taskId: string) {
    this.tasks.delete(taskId);
    for (const entry of this.pages.values()) {
      const tasks = entry.value.tasks;
      const items = tasks.items.filter((item) => item.id !== taskId);
      if (items.length === tasks.items.length) continue;
      entry.value = {
        ...entry.value,
        tasks: { ...tasks, items, total: Math.max(0, tasks.total - 1) },
      };
    }
  }

  forgetBoardPages(boardId: string) {
    for (const [key, entry] of this.pages) {
      if (entry.value.board.id === boardId) this.pages.delete(key);
    }
  }

  forgetBoard(boardId: string) {
    this.forgetBoardPages(boardId);
    for (const [id, entry] of this.tasks) {
      if (entry.value.boardId === boardId) this.tasks.delete(id);
    }
  }
}

export const navigationCache = new NavigationCache();
