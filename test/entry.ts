// The Workers pool needs a main module. Tests build their Worker from the fixture config with
// createWorker(env.TEST_CONFIG) instead, so this one does nothing.
export default { fetch: () => new Response(null, { status: 404 }) } satisfies ExportedHandler;
