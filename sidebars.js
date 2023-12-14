/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */

// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  // By default, Docusaurus generates a sidebar from the docs folder structure
  //tutorialSidebar: [{type: 'autogenerated', dirName: '.'}],

  // But you can create a sidebar manually
  tutorialSidebar: [
    {
      type: 'doc',
      label: '介绍',
      id: 'intro',
    },
    'other/businesscase',
    {
      type: 'category',
      label: '新手教程',
      link: {
        type: 'generated-index',
        slug: '/beginner',
      },
      collapsed: false,
      items: [
        'beginner/quickstart',
        'beginner/monobehaviour',
        'beginner/generic',
        'beginner/otherhelp',
      ],
    },
    {
      type: 'category',
      label: '使用指南',
      link: {
        type: 'generated-index',
        slug: '/basic',
      },
      collapsed: true,
      items: [
        'basic/supportedplatformanduniyversion',
        'basic/install',
        'basic/projectsettings',
        'basic/hotupdateassemblysetting',
        'basic/runhotupdatecodes',
        'basic/buildpipeline',
        'basic/buildwebgl',
        'basic/codestriping',
        'basic/monobehaviour',
        'basic/aotgeneric',
        'basic/methodbridge',
        'basic/memory',
        'basic/performance',
        'basic/notsupportedfeatures',
        'basic/com.code-philosophy.hybridclr',
        'basic/bestpractice',
        'basic/migratefromnetstandard',
        'basic/workwithscriptlanguage',
        'basic/architecture',
        'basic/sourceinspect',
        'basic/il2cppbugs',
      ],
    },
    {
      type: 'category',
      label: '商业化版本',
      link: {
        type: 'generated-index',
        slug: '/business',
      },
      collapsed: true,
      items: [
        'business/intro',
        'business/differentialhybridexecution',
        'business/fullgenericsharing',
        'business/metadataoptimization',
        'business/basiccodeoptimization',
        'business/basicencryption',
        'business/advancedcodeoptimization',
        'business/advancedencryption',
        'business/ilinterpreter',
        'business/accesspolicy',
        'business/businesscase',
        {
          type: 'category',
          label: '旗舰版',
          link: {
            type: 'generated-index',
            slug: '/ultimate',
          },
          collapsed: true,
          items: [
            'business/ultimate/intro',
            'business/ultimate/quickstart',
            'business/ultimate/manual',
          ],
        },
        {
          type: 'category',
          label: '专业版',
          link: {
            type: 'generated-index',
            slug: '/pro',
          },
          collapsed: true,
          items: [
            'business/pro/intro',
            'business/pro/quickstart',
          ],
        },
        {
          type: 'category',
          label: '热重载版',
          link: {
            type: 'generated-index',
            slug: '/reload',
          },
          collapsed: true,
          items: [
            'business/reload/intro',
            'business/reload/quickstart',
            'business/reload/hotreloadassembly',
            'business/reload/modifydll',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: '帮助',
      link: {
        type: 'generated-index',
        slug: '/help',
      },
      collapsed: true,
      items: [
        'help/faq',
        'help/commonerrors',
        'help/issue',
      ],
    },
    {
      type: 'category',
      label: '其他',
      link: {
        type: 'generated-index',
        slug: '/other',
      },
      collapsed: true,
      items: [
        'other/relativepojects',
        'other/roadmap',
        'other/changelog',
        'other/donate',
        'other/contactme',
      ],
    },
  ],
};

module.exports = sidebars;
