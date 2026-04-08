name: Feature Request (AI)
description: Request a feature to be built by the AI agent
title: "[AI] "
labels: ["ai-task"]

body:
  - type: textarea
    id: description
    attributes:
      label: Feature Description
      description: Clearly describe the feature
      placeholder: Add event capacity and prevent overbooking
    validations:
      required: true

  - type: textarea
    id: requirements
    attributes:
      label: Requirements
      description: Acceptance criteria
      placeholder: |
        - Add capacity field to event
        - Prevent overbooking
        - Show error in UI