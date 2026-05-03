const { v4: uuidv4 } = require('uuid');
const cloudant = require('./services/cloudantClient');
const DB_NAME = 'community_posts';

async function test() {
  try {
    const user = {
      email: 'test@example.com',
      sub: '12345',
      identityToken: null
    };
    
    const email = user.email || (user.emails && user.emails[0]?.value) || 'Anonymous';
    let userId = user.sub || email;
    
    const newPost = {
      _id: uuidv4(),
      user_id: userId,
      email: email,
      content: 'This is a test post',
      created_at: new Date().toISOString()
    };

    const response = await cloudant.postDocument({
      db: DB_NAME,
      document: newPost
    });

    console.log('Success:', response.result);
  } catch (err) {
    console.error('Error:', err);
  }
}

setTimeout(test, 2000);
