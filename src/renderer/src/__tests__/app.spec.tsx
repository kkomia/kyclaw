import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '@renderer/App'

describe('App', () => {
  it('renders without crashing', () => {
    render(<App />)

    expect(screen.getByTestId('app-root')).toBeInTheDocument()
  })
})
