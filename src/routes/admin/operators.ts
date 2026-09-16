import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import type { OperatorRegistry } from '../../operators/registry';

/** Enterprise-only admin surface; wiring follows the package's behavioral RED. */
const app = new Hono<{ Bindings: Env & { OPERATOR_REGISTRY?: DurableObjectNamespace<OperatorRegistry> }; Variables: AuthVariables }>();
export default app;
