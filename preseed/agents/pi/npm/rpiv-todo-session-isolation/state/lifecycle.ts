import type { TaskState } from "./state.js";
import {
	clearActiveRenderSession,
	evictSession,
	getActiveRenderSession,
	replaceState,
	sid,
} from "./store.js";

type SessionContext = Parameters<typeof sid>[0] & Record<string, any>;
type SessionHandler = (event: unknown, ctx: SessionContext) => void | Promise<void>;
type SessionPi = {
	on(event: "session_start" | "session_compact" | "session_tree" | "session_shutdown", handler: SessionHandler): void;
};
type LifecycleDependencies = {
	replayFromBranch(ctx: SessionContext): TaskState;
	onSessionStart(sessionId: string, ctx: SessionContext): void;
	onForegroundReplay(): void;
	onActiveShutdown(): void;
};

function isStaleCtxError(error: unknown): boolean {
	return /stale after session replacement/.test(String(error));
}

export function registerSessionStateLifecycle(pi: SessionPi, dependencies: LifecycleDependencies): void {
	const replayAndRefresh = (ctx: SessionContext): void => {
		let isForeground = false;
		try {
			const sessionId = sid(ctx);
			replaceState(sessionId, dependencies.replayFromBranch(ctx));
			isForeground = sessionId === getActiveRenderSession();
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
		}
		if (isForeground) dependencies.onForegroundReplay();
	};

	pi.on("session_start", async (_event, ctx) => {
		let sessionId: string;
		try {
			sessionId = sid(ctx);
			replaceState(sessionId, dependencies.replayFromBranch(ctx));
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
			return;
		}
		dependencies.onSessionStart(sessionId, ctx);
	});

	pi.on("session_compact", async (_event, ctx) => replayAndRefresh(ctx));
	pi.on("session_tree", async (_event, ctx) => replayAndRefresh(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		let sessionId: string;
		try {
			sessionId = sid(ctx);
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
			sessionId = "";
		}
		evictSession(sessionId);
		if (sessionId !== "" && sessionId !== getActiveRenderSession()) return;
		try {
			dependencies.onActiveShutdown();
		} finally {
			clearActiveRenderSession();
		}
	});
}
