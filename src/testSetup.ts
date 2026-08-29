import { globalAgent } from 'node:http';

/*
 * No keep-alive between a test and its own server.
 *
 * Node 19 turned `http.globalAgent.keepAlive` on by default. The server
 * suites stand up a listener per test and close it afterwards, so an idle
 * socket the agent has kept outlives the server it was opened to — and the
 * next request, to a new server that may well have been given the same
 * port, goes out on it.
 *
 * What that looked like was not a connection error. It was a POST arriving
 * at Express with a mangled path (its own 404, for a route that is
 * unconditionally registered), or a truncated body (`express.json`
 * answering 400 with nothing in it), roughly one full run in nine. Both
 * were read as product bugs for a while, and neither had anything to do
 * with the code under test.
 *
 * Tests only: nothing in the app talks to itself over HTTP.
 */
// `keepAlive` is settable at runtime but absent from the Agent type, which
// only declares it as a constructor option.
(globalAgent as unknown as { keepAlive: boolean }).keepAlive = false;
globalAgent.destroy();
