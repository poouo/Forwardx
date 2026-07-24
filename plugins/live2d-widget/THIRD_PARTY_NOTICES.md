# Third-party notices

## Live2D Widget

ForwardX loads the browser runtime from the pinned npm package `live2d-widgets@1.0.1`, published from [stevenjoezhang/live2d-widget](https://github.com/stevenjoezhang/live2d-widget). The upstream project is Copyright (c) stevenjoezhang and contributors and is licensed under the GNU General Public License, version 3 or later.

The exact runtime files are loaded only after an administrator enables this plugin. ForwardX does not modify or redistribute the upstream JavaScript package in the plugin archive. Source, license text, and the upstream project history are available from the linked repository and npm package. A complete copy of the upstream GPL-3.0 license is included in `LICENSE.live2d-widget.txt` for convenient inspection.

## Live2D Cubism Core

Cubism 2 and Cubism 5 core files are fetched from the URLs documented by the upstream widget and Live2D. They are not part of ForwardX's source or release archive. Cubism Core is subject to the Live2D Proprietary Software License Agreement and/or Live2D Open Software License Agreement as applicable:

- https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html
- https://www.live2d.com/eula/live2d-open-software-license-agreement_cn.html

## Model repositories and optional tools

ForwardX does not bundle model files. The default model endpoint is `fghrsh/live2d_api`; its model files and any other endpoint selected by an administrator have their own copyright and usage terms. The optional `hitokoto` and `asteroids` tools can contact their respective third-party services when a user clicks them.
