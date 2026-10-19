import { mockStore } from './app';

export default { fetch: (req: Request) => mockStore.fetch(req) };
