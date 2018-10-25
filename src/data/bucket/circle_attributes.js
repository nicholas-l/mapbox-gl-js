// @flow
import { createLayout } from '../../util/struct_array';

const layout = createLayout([
    {name: 'a_pos', components: 4, type: 'Uint16'}
], 4);

export default layout;
export const {members, size, alignment} = layout;
