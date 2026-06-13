const fs = require('fs');

// 16x16 PNG — orange paw — generated as a minimal valid PNG
// This is a base64-encoded 16x16 orange square PNG as a fallback tray icon
const base64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABQSURBVDiNY/z//z8DJYCJgUIwasCoAaMGjBowasCoAf9HGzBqwKgBgzZg1IBRAwhtwKgBhDZg1ABCG4AXjBowasCoAaMGoBkAAODHCRRTiQJsAAAAAElFTkSuQmCC';

fs.writeFileSync('tray.png', Buffer.from(base64, 'base64'));
console.log('wrote tray.png');