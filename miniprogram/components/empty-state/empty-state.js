/** 空态：标题 + 说明 + 可选按钮（登录引导等） */
Component({
  properties: {
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' },
  },
  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
