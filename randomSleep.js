module.exports.randomSleep = async (min, max) => {
  const time = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`Sleeping for ${time} ms`);
  await new Promise((resolve) => setTimeout(resolve, time));
};
