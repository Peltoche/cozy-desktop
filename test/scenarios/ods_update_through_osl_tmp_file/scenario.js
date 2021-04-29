/* @flow */

/*:: import type { Scenario } from '..' */

module.exports = ({
  side: 'local',
  useCaptures: false,
  init: [{ ino: 1, path: 'file.ods', content: 'initial content' }],
  actions: [
    { type: 'mv', src: 'file.ods', dst: 'file.ods.osl-tmp' },
    { type: 'create_file', path: 'file.ods' },
    { type: 'update_file', path: 'file.ods', content: 'updated content #1' },
    { type: 'delete', path: 'file.ods.osl-tmp' },
    { type: 'wait', ms: 1000 }
  ],
  expected: {
    tree: ['file.ods'],
    trash: [],
    contents: {
      'file.ods': 'updated content #1'
    }
  }
} /*: Scenario */)
