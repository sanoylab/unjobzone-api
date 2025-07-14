require("dotenv").config();
const { Client } = require('pg');
const { credentials } = require("./db");

async function generateJobRelatedBlogPost() {
    const apiKey = `${process.env.OPENAI_API_KEY}`; // Replace with your OpenAI API key
    const prompt = `
    Generate a comprehensive blog post about 4 to 5 paragraph for an international organization, such as the United Nations, Job Application. The response should include:

A catchy and professional title (plain text, no HTML tags).
A detailed body of the blog post with the following structure, formatted with HTML tags:
An introductory paragraph wrapped in <p> tags, providing an overview of the topic.
Several sections with appropriate headings that delve into different aspects of the topic.
Bullet points for listing relevant points or examples, where applicable.
Closing remarks in a paragraph wrapped in <p> tags, summarizing the discussion or offering a call-to-action.
Ensure the content is engaging, professional, and provides valuable insights related to international development, humanitarian work, or global collaboration. Avoid generic text and focus on delivering depth and specificity.
    `;
    const thumbnailUrls = [
        'https://images.pexels.com/photos/313690/pexels-photo-313690.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/327540/pexels-photo-327540.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/585419/pexels-photo-585419.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/165907/pexels-photo-165907.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/3756681/pexels-photo-3756681.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/1462650/pexels-photo-1462650.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/776615/pexels-photo-776615.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/1020777/pexels-photo-1020777.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/5198239/pexels-photo-5198239.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/3769138/pexels-photo-3769138.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/1015568/pexels-photo-1015568.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/886521/pexels-photo-886521.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/2325447/pexels-photo-2325447.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/248159/pexels-photo-248159.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/1714208/pexels-photo-1714208.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/577585/pexels-photo-577585.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/10629418/pexels-photo-10629418.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/7238309/pexels-photo-7238309.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/6757958/pexels-photo-6757958.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/6281880/pexels-photo-6281880.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/1078850/pexels-photo-1078850.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/1275393/pexels-photo-1275393.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/3039036/pexels-photo-3039036.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/12886800/pexels-photo-12886800.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/6757969/pexels-photo-6757969.jpeg?auto=compress&cs=tinysrgb&w=600',
        'https://images.pexels.com/photos/6507744/pexels-photo-6507744.jpeg?auto=compress&cs=tinysrgb&w=600',
    ];
  
    try {
      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [{ role: 'system', content: prompt }],
            max_tokens: 2048,
            n: 1,
            stop: null,
            temperature: 0.7,
          }),
        }
      );
  
      const data = await response.json();
      let generatedText = data.choices[0].message.content.trim();
      let [title, ...body] = generatedText.split('\n').filter(line => line.trim() !== '');
      console.log('Generated blog post:', { title, body });
      // Remove "Title: " prefix if it exists
      if (title.startsWith('Title: ')) {
        title = title.replace('Title: ', '');
      }

      // Remove double quotes from the title
      title = title.replace(/"/g, '');

      // Select a random thumbnail URL
      const thumbnail = thumbnailUrls[Math.floor(Math.random() * thumbnailUrls.length)];

      const blogPost = {
        title: title,
        content: body.join('\n'),
        featured: "No",
        thumbnail: thumbnail
      };

      // Save the blog post to the database
      const client = new Client(credentials);
      await client.connect();
      const query = `
        INSERT INTO public.blog (title, content, featured, thumbnail)
        VALUES ($1, $2, $3, $4)
        RETURNING id;
      `;
      const values = [blogPost.title, blogPost.content, blogPost.featured, blogPost.thumbnail];
      const res = await client.query(query, values);
      await client.end();

      return { id: res.rows[0].id, ...blogPost };
    } catch (error) {
      console.error('Error generating blog post:', error);
      throw new Error('Failed to generate blog post');
    }
}

module.exports = { generateJobRelatedBlogPost };