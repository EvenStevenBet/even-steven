// Preloaded by the dry-run tests: any network call fails the run.
globalThis.fetch = async () => { throw new Error('network call attempted') }
