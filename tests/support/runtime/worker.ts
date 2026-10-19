// Production API and runtime, isolated control routes and mocked upstream.
import { installMockUpstream } from '../providers/upstream';
import { createTestWorker } from './control-routes';
import { authenticateLocal } from '../../../scripts/dev/worker';
export { Conversation } from './conversation';
export { Library } from './library';
export { UsageStore } from '../../../worker/usage/durable-object';
export { ShareStore } from '../../../worker/sharing/durable-object';
export { WebToolWorkflow } from './tool-workflow-metrics';
installMockUpstream();
export default createTestWorker(authenticateLocal, '/__dev/access/login');
