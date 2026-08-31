import type { TcsfFactory } from "./factory.ts";
export async function recoverRun(factory: TcsfFactory, taskId: string) { return factory.resumeRun(taskId); }
