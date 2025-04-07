import fs from 'fs/promises';
import path from 'path';

const rulesDir = 'rules';
const outputDir = '.cursor/rules';

async function generateIndividualRules() {
  try {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    // Get all files from rules directory
    const files = await fs.readdir(rulesDir);
    const mdFiles = files.filter(file => file.endsWith('.md'));

    // Keep track of generated mdc files to potentially remove orphans later
    const generatedMdcFiles = new Set();

    if (mdFiles.length === 0) {
      console.log(`No .md files found in ${rulesDir}.`);
      // Optionally remove all .mdc files in outputDir if desired
      // ... (logic to remove existing .mdc files) ...
      return;
    }

    // Process each .md file
    for (const mdFile of mdFiles) {
      const sourcePath = path.join(rulesDir, mdFile);
      const outputFilename = mdFile.replace(/\.md$/, '.mdc'); // Change extension
      const outputPath = path.join(outputDir, outputFilename);
      generatedMdcFiles.add(outputFilename); // Track generated file

      try {
        // Read content from .md file
        const content = await fs.readFile(sourcePath, 'utf-8');

        // Write content to .mdc file
        // You could add headers/footers here if needed, but keeping it simple for now
        await fs.writeFile(outputPath, content);
        console.log(`Generated: ${outputPath} from ${mdFile}`);

      } catch (readWriteError) {
        console.error(`Error processing ${mdFile}:`, readWriteError);
      }
    }

    // Optional: Clean up orphan .mdc files in .cursor/rules
    // (Files that exist in .cursor/rules but don't have a corresponding .md in rules/)
    try {
        const existingMdcFiles = await fs.readdir(outputDir);
        for (const existingFile of existingMdcFiles) {
            if (existingFile.endsWith('.mdc') && !generatedMdcFiles.has(existingFile)) {
                const orphanPath = path.join(outputDir, existingFile);
                await fs.unlink(orphanPath);
                console.log(`Deleted orphan rule file: ${orphanPath}`);
            }
        }
    } catch(cleanupError) {
        // Ignore if outputDir doesn't exist, but log other errors
        if (cleanupError.code !== 'ENOENT') {
            console.error(`Error during cleanup of ${outputDir}:`, cleanupError);
        }
    }


    console.log('Individual Project Rules generation complete.');

  } catch (err) {
    console.error('Error generating individual Project Rules:', err);
  }
}

generateIndividualRules(); 