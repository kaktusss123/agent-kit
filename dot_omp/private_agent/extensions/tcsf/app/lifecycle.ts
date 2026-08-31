import type { TcsfFactory } from "./factory.ts";
export async function advanceRun(factory: TcsfFactory, taskId: string) { return factory.advanceRun(taskId); }
