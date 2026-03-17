import pc from 'picocolors';
import * as output from '../lib/output.js';
import { getGuideContent, getAvailableTopics } from '../lib/guide-content.js';

const VALID_TOPICS = ['overview', 'actions', 'flows', 'all'] as const;
type GuideTopic = (typeof VALID_TOPICS)[number];

export async function guideCommand(topic: string = 'all'): Promise<void> {
  if (!VALID_TOPICS.includes(topic as GuideTopic)) {
    output.error(
      `Unknown topic "${topic}". Available topics: ${VALID_TOPICS.join(', ')}`
    );
  }

  const { title, content } = getGuideContent(topic as GuideTopic);
  const availableTopics = getAvailableTopics();

  if (output.isAgentMode()) {
    output.json({ topic, title, content, availableTopics });
    return;
  }

  output.intro(pc.bgCyan(pc.black(' One Guide ')));
  console.log();
  console.log(content);
  console.log(pc.dim('─'.repeat(60)));
  console.log(
    pc.dim('Available topics: ') +
      availableTopics.map((t) => pc.cyan(t.topic)).join(', ')
  );
  console.log(pc.dim(`Run ${pc.cyan('one guide <topic>')} for a specific section.`));
}
