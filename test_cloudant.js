const cloudant = require('./services/cloudantClient');

async function test() {
  try {
    const response = await cloudant.postDocument({
      db: 'community_posts',
      document: { title: 'Test Post', content: 'Hello World' }
    });
    console.log('Success:', response.result);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

setTimeout(test, 2000);
