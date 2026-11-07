<script setup lang="ts">
import {computed} from 'vue';import {fontSize} from '../font-size';
import {use} from 'echarts/core';import {BarChart,GraphChart} from 'echarts/charts';import {GridComponent,TooltipComponent,AriaComponent} from 'echarts/components';import {SVGRenderer} from 'echarts/renderers';import VChart from 'vue-echarts';
use([BarChart,GraphChart,GridComponent,TooltipComponent,AriaComponent,SVGRenderer]);
const props=defineProps<{option:Record<string,unknown>;label:string}>();
// 图表使用自身绘制的文字，显式传入字号才能与CSS正文同步。
const scaledOption=computed(()=>({...props.option,textStyle:{...(props.option.textStyle as Record<string,unknown>||{}),fontSize:12*fontSize.value/100}}));
</script><template><div class="chart-surface" role="img" :aria-label="label"><VChart :option="scaledOption" autoresize :init-options="{renderer:'svg'}"/></div></template>
