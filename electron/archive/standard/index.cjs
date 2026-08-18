// Public facade for the universal archive contract. Providers may parse their
// own source format, but they all write and read through this module.
module.exports = {
  ...require('./reader.cjs'),
  ...require('./writer.cjs'),
};
