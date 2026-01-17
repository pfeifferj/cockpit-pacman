import { Component, ErrorInfo, ReactNode } from "react";
import {
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Button,
  ExpandableSection,
  CodeBlock,
  CodeBlockCode,
} from "@patternfly/react-core";
import { ExclamationCircleIcon } from "@patternfly/react-icons";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReload = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    });
  };

  render(): ReactNode {
    const { hasError, error, errorInfo, showDetails } = this.state;
    const { children, fallbackTitle = "Something went wrong" } = this.props;

    if (hasError) {
      return (
        <EmptyState
          headingLevel="h2"
          icon={ExclamationCircleIcon}
          titleText={fallbackTitle}
          status="danger"
        >
          <EmptyStateBody>
            An error occurred while rendering this section. You can try reloading
            to recover.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={this.handleReload}>
                Reload
              </Button>
            </EmptyStateActions>
            {(error || errorInfo) && (
              <ExpandableSection
                toggleText={showDetails ? "Hide details" : "Show details"}
                onToggle={(_event, expanded) => this.setState({ showDetails: expanded })}
                isExpanded={showDetails}
              >
                <CodeBlock>
                  <CodeBlockCode>
                    {error?.toString()}
                    {errorInfo?.componentStack}
                  </CodeBlockCode>
                </CodeBlock>
              </ExpandableSection>
            )}
          </EmptyStateFooter>
        </EmptyState>
      );
    }

    return children;
  }
}
