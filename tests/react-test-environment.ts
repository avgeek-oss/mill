// React's act helper requires its development build. Node isolates each test
// file in a separate process, so API suites keep their production environment.
process.env.NODE_ENV = "test";
