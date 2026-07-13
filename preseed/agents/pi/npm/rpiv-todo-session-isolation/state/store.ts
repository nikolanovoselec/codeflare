import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/** Per-session state prevents child lifecycle replay from clobbering foreground tasks. */
const sessions = new Map<string, TaskState>();
let activeRenderSession = "";

export function sid(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function slotFor(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

export function getTodos(sessionId: string): readonly Task[] {
	return slotFor(sessionId).tasks;
}

export function getNextId(sessionId: string): number {
	return slotFor(sessionId).nextId;
}

export function getState(sessionId: string): TaskState {
	return slotFor(sessionId);
}

export function replaceState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

export function commitState(sessionId: string, next: TaskState): void {
	sessions.set(sessionId, next);
}

export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

export function getRenderState(): TaskState {
	return slotFor(activeRenderSession);
}

export function setActiveRenderSession(sessionId: string): void {
	activeRenderSession = sessionId;
}

export function getActiveRenderSession(): string {
	return activeRenderSession;
}

export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}

export function __resetState(): void {
	sessions.clear();
	activeRenderSession = "";
}
