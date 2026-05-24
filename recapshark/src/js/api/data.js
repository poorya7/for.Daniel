import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';

/**
 * RecapShark Data Service
 * Handles data transformation between API responses and app state.
 * Single responsibility: parse, convert, and map data structures.
 */
export const DataService = (() => {

  function _processSpeakerMarkers(t) {
    const raw = (t || '').trim();
    if (!raw) return { lines: [], hasSpeakers: false };
    const hasMarkers = />>|<</.test(raw);
    if (!hasMarkers) return { lines: [raw], hasSpeakers: false };
    const turns = raw.split(/\s*>>\s*|\s*<<\s*/).map(s => s.trim()).filter(Boolean);
    return { lines: turns.map(turn => turn.replace(/\n+/g, ' ')), hasSpeakers: true };
  }

  function _stripSpeakerMarkers(t) {
    return (t || '').replace(/\s*>>\s*/g, ' ').replace(/\s*<<\s*/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function convertApiResponse(videoId, videoInfo, transcript, summary, chapters, lang) {
    const segments = transcript.segments || [];
    const MIN_LINE_CHARS = 50;
    const lines = [];
    const segmentTimes = [];
    let pendingText = '';
    let pendingTime = 0;
    for (const s of segments) {
      const { lines: turnLines, hasSpeakers } = _processSpeakerMarkers(s.text || '');
      const start = s.start || 0;
      if (hasSpeakers && turnLines.length > 0) {
        if (pendingText) {
          lines.push(pendingText);
          segmentTimes.push(pendingTime);
          pendingText = '';
        }
        for (const line of turnLines) {
          lines.push(line);
          segmentTimes.push(start);
        }
        continue;
      }
      const subLines = (turnLines[0] || _stripSpeakerMarkers(s.text || '')).split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean);
      for (const line of subLines) {
        if (!pendingText) {
          pendingText = line;
          pendingTime = start;
        } else {
          pendingText += ' ' + line;
        }
        if (pendingText.length >= MIN_LINE_CHARS) {
          lines.push(pendingText);
          segmentTimes.push(pendingTime);
          pendingText = '';
        }
      }
    }
    if (pendingText) {
      lines.push(pendingText);
      segmentTimes.push(pendingTime);
    }
    const rawText = lines.join('\n');
    const subs = segments.map(s => {
      const { lines: turnLines, hasSpeakers } = _processSpeakerMarkers(s.text || '');
      const text = hasSpeakers ? turnLines.join(' ') : _stripSpeakerMarkers(s.text || '');
      return { start: s.start || 0, end: s.end || 0, text };
    });

    let topics = [];

    if (chapters && chapters.length > 0) {
      const segLineOffsets = [];
      let runningLines = 0;
      for (const s of segments) {
        segLineOffsets.push(runningLines);
        const count = (s.text || '').trim().split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean).length;
        runningLines += count || 1;
      }

      topics = chapters.map(ch => {
        const segIdx = segments.findIndex(s => s.start >= ch.start_time);
        const lineStart = segIdx >= 0 ? segLineOffsets[segIdx] : 0;
        return {
          title: ch.title || 'Introduction',
          lineStart,
          timestamp: ch.start_time,
          children: [],
        };
      });
    } else {
      const TOPIC_INTERVAL_SEC = 600;
      let nextBreak = 0;
      segments.forEach((seg, i) => {
        if (seg.start >= nextBreak) {
          topics.push({
            title: `Section ${topics.length + 1}`,
            lineStart: i,
            children: [],
          });
          nextBreak = seg.start + TOPIC_INTERVAL_SEC;
        }
      });
    }

    if (topics.length === 0) {
      topics.push({ title: 'Full Video', lineStart: 0, children: [] });
    }

    const duration = transcript.duration
      || (segments.length ? segments[segments.length - 1].end : 0);

    const summaryParagraphs = (summary && summary.length > 0)
      ? summary
      : ['Generating summary...'];

    return {
      videoData: {
        videoId,
        title: videoInfo?.title || 'Untitled Video',
        channel: videoInfo?.channel || '',
        durationEstimate: duration,
        summary: summaryParagraphs,
        topics,
        keywords: {},
        lang: lang || 'en',
      },
      rawText,
      segmentTimes,
      subs,
    };
  }

  function parseTranscript(raw) {
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    AppState.totalLines = lines.length;

    const CHUNK_SIZE = 6;
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      const chunk = lines.slice(i, i + CHUNK_SIZE);
      const text = chunk.map(l => l.replace(/^- /, '')).join(' ');
      AppState.transcriptSegments.push({
        text,
        startLine: i,
        endLine: Math.min(i + CHUNK_SIZE, lines.length),
        startTime: Helpers.lineToTime(i),
        endTime: Helpers.lineToTime(Math.min(i + CHUNK_SIZE, lines.length)),
      });
    }
  }

  function addTimestampsToTopics() {
    AppState.videoData.topics.forEach(t => {
      if (t.timestamp == null) t.timestamp = Helpers.lineToTime(t.lineStart);
      (t.children || []).forEach(sub => {
        if (sub.timestamp == null) sub.timestamp = Helpers.lineToTime(sub.lineStart);
      });
    });
  }

  function findTopicMatchForLine(lineNum) {
    const topics = AppState.videoData?.topics || [];
    if (topics.length === 0) return null;

    let topicIdx = 0;
    for (let i = 0; i < topics.length; i++) {
      if (lineNum >= topics[i].lineStart) topicIdx = i;
      else break;
    }

    const topic = topics[topicIdx];
    const topicEnd = topicIdx < topics.length - 1
      ? topics[topicIdx + 1].lineStart - 1
      : Number.POSITIVE_INFINITY;

    let subIdx = null;
    (topic.children || []).forEach((sub, i) => {
      if (sub.lineStart <= lineNum && sub.lineStart <= topicEnd) subIdx = i;
    });

    return { topicIdx, subIdx };
  }

  function getTopicPathForLine(lineNum) {
    const match = findTopicMatchForLine(lineNum);
    if (!match) return '';
    const topic = AppState.videoData?.topics?.[match.topicIdx];
    if (!topic) return '';
    const sub = match.subIdx !== null ? topic.children?.[match.subIdx] : null;
    if (sub?.title) return `${topic.title} > ${sub.title}`;
    return topic.title || '';
  }

  return { convertApiResponse, parseTranscript, addTimestampsToTopics, findTopicMatchForLine, getTopicPathForLine };
})();
