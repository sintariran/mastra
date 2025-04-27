import dotenv from 'dotenv';
import path from 'path';

// Explicitly point to the .env file in the current directory
const envPath = path.resolve(process.cwd(), '.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error('Error loading .env file:', result.error);
} else {
  console.log('Dotenv loaded successfully.');
  console.log('DATABASE_URL:', process.env.DATABASE_URL);
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY);
} 