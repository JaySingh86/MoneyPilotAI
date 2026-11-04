// The same handlers the browser mock uses, served to jsdom tests through msw/node.
import { setupServer } from "msw/node";
import { handlers } from "../mocks/handlers";

export const server = setupServer(...handlers);
